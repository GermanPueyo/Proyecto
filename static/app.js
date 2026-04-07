/* =============================================================
   WinRM Server Monitor — Frontend Logic
   ============================================================= */

let SID = null;
let SPECS = {};
let POLL = null;
const MAX_PTS = 60;

const history = {
  cpu: [], ram: [], disk: [],
  net_up: [], net_dn: []
};

let chartCpuRam = null;
let chartNet = null;

// Toggle state for KPI filters
const visible = { cpu: true, ram: true, disk: true, net: true };

/* =============================================================
   HOME / MODAL
   ============================================================= */
function openLoginModal() {
  document.getElementById('login-modal').classList.add('active');
  document.getElementById('inp-pwd').focus();
}

function closeLoginModal() {
  document.getElementById('login-modal').classList.remove('active');
  document.getElementById('login-error').classList.remove('show');
}

async function doConnect() {
  const ip   = document.getElementById('inp-ip').value.trim();
  const user = document.getElementById('inp-user').value.trim();
  const pwd  = document.getElementById('inp-pwd').value;
  const errBox = document.getElementById('login-error');
  const btn    = document.getElementById('btn-connect');
  const spinner = document.getElementById('login-spinner');
  const btnTxt  = document.getElementById('btn-connect-text');

  if (!ip || !user || !pwd) {
    errBox.textContent = 'Todos los campos son obligatorios';
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnTxt.textContent = 'Conectando…';
  errBox.classList.remove('show');

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, user, password: pwd })
    });
    const data = await res.json();

    if (!data.ok) {
      errBox.textContent = data.error || 'Error de conexión';
      errBox.classList.add('show');
      return;
    }

    SID = data.sid;
    SPECS = data.specs;
    closeLoginModal();
    enterDashboard(ip);

  } catch (e) {
    errBox.textContent = 'No se pudo contactar con el backend';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnTxt.textContent = 'Conectar';
  }
}

/* =============================================================
   ENTER / EXIT DASHBOARD
   ============================================================= */
function enterDashboard(ip) {
  document.getElementById('home-screen').style.display = 'none';
  document.getElementById('dashboard-screen').style.display = 'block';
  document.getElementById('dash-ip').textContent = ip;
  document.getElementById('footer-ip').textContent = ip;

  for (const k in history) history[k] = [];

  // Switch view first so the canvas containers are visible
  switchView('monitor', document.querySelector('[data-view="monitor"]'));

  // Defer chart init to next frame so the browser has laid out the DOM
  // and canvas elements have real dimensions for Chart.js
  requestAnimationFrame(() => {
    setTimeout(() => {
      initCharts();
      setupKpiToggles();
      renderSpecs();
      loadDisks();
      startPolling();
    }, 100);
  });
}

let _polling = false;

function startPolling() {
  if (POLL) clearInterval(POLL);
  fetchMetricsOnce();
  POLL = setInterval(fetchMetricsOnce, 1000);
}

async function fetchMetricsOnce() {
  if (!SID || _polling) return;
  _polling = true;
  try {
    const res = await fetch('/api/metrics?sid=' + SID);
    const d = await res.json();
    if (!d.ok) { _polling = false; return; }

    pushHistory('cpu',    d.cpu);
    pushHistory('ram',    d.ram);
    pushHistory('disk',   d.disk);
    pushHistory('net_up', d.sent_mbps);
    pushHistory('net_dn', d.recv_mbps);

    updateKPIs(d);
    updateCharts();
    updateStats(d);
  } catch (e) {
    // Silently retry next interval
  }
  _polling = false;
}

function doDisconnect() {
  if (POLL) clearInterval(POLL);
  POLL = null;
  _polling = false;

  fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: SID })
  }).catch(() => {});

  SID = null;
  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = '';

  if (chartCpuRam) { chartCpuRam.destroy(); chartCpuRam = null; }
  if (chartNet)    { chartNet.destroy();    chartNet = null; }
}

/* =============================================================
   VIEW SWITCHING (SPA)
   ============================================================= */
function switchView(name, btn) {
  document.querySelectorAll('[id^="view-"]').forEach(v => v.style.display = 'none');
  document.getElementById('view-' + name).style.display = '';

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (name === 'dhcp') {
    loadDhcp();
  }
}

/* =============================================================
   KPI CARD TOGGLE (Click to show/hide from chart)
   ============================================================= */
function setupKpiToggles() {
  const map = { 'kpi-cpu': 'cpu', 'kpi-ram': 'ram', 'kpi-disk': 'disk', 'kpi-net': 'net' };
  for (const [cardId, key] of Object.entries(map)) {
    const card = document.getElementById(cardId);
    if (!card) continue;
    // Reset state
    visible[key] = true;
    card.classList.remove('disabled');
    card.onclick = () => {
      visible[key] = !visible[key];
      card.classList.toggle('disabled', !visible[key]);
      applyChartVisibility();
    };
  }
}

function applyChartVisibility() {
  if (!chartCpuRam || !chartNet) return;
  // CPU = 0, RAM = 1, Disk = 2
  chartCpuRam.data.datasets[0].hidden = !visible.cpu;
  chartCpuRam.data.datasets[1].hidden = !visible.ram;
  chartCpuRam.data.datasets[2].hidden = !visible.disk;
  chartCpuRam.update();

  chartNet.data.datasets[0].hidden = !visible.net;
  chartNet.data.datasets[1].hidden = !visible.net;
  chartNet.update();
}

/* =============================================================
   CHARTS (Chart.js)
   ============================================================= */
function initCharts() {
  // Destroy old charts if any (reconnection scenario)
  if (chartCpuRam) { chartCpuRam.destroy(); chartCpuRam = null; }
  if (chartNet)    { chartNet.destroy();    chartNet = null; }

  const gridColor = 'rgba(110,74,48,.5)';
  const shared = {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 2.2,
    animation: { duration: 400 },
    interaction: { intersect: false, mode: 'index' },
    scales: {
      x: { display: false },
      y: {
        min: 0, max: 100,
        grid: { color: gridColor },
        ticks: { color: '#e3d0a9', font: { size: 11 } }
      }
    },
    plugins: {
      legend: {
        display: true,
        labels: { color: '#fffaed', boxWidth: 12, padding: 16 }
      }
    },
    elements: { point: { radius: 0 }, line: { tension: .35 } }
  };

  const ctx1 = document.getElementById('chart-cpu-ram').getContext('2d');
  chartCpuRam = new Chart(ctx1, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'CPU %', data: [], borderColor: '#f6cbcc', backgroundColor: 'rgba(246,203,204,.15)', fill: true, borderWidth: 2.5 },
        { label: 'RAM %', data: [], borderColor: '#83b4bb', backgroundColor: 'rgba(131,180,187,.12)', fill: true, borderWidth: 2.5 },
        { label: 'Disco %', data: [], borderColor: '#e3d0a9', backgroundColor: 'rgba(227,208,169,.1)', fill: true, borderWidth: 2, borderDash: [6,3] }
      ]
    },
    options: JSON.parse(JSON.stringify(shared))
  });

  const ctx2 = document.getElementById('chart-net').getContext('2d');
  const netOpts = JSON.parse(JSON.stringify(shared));
  delete netOpts.scales.y.max;
  netOpts.scales.y.suggestedMax = 1;
  chartNet = new Chart(ctx2, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Recepción ↓', data: [], borderColor: '#83b4bb', backgroundColor: 'rgba(131,180,187,.12)', fill: true, borderWidth: 2 },
        { label: 'Envío ↑',     data: [], borderColor: '#f6cbcc', backgroundColor: 'rgba(246,203,204,.1)',  fill: true, borderWidth: 2 }
      ]
    },
    options: netOpts
  });
}

/* =============================================================
   POLLING helpers
   ============================================================= */
function pushHistory(key, val) {
  history[key].push(val);
  if (history[key].length > MAX_PTS) history[key].shift();
}

function colorForPct(pct) {
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

function updateKPIs(d) {
  setKPI('cpu',  d.cpu + '%', d.cpu);
  setKPI('ram',  d.ram + '%', d.ram);
  setKPI('disk', d.disk + '%', d.disk);

  const netTotal = (d.recv_mbps + d.sent_mbps).toFixed(1);
  document.getElementById('kpi-net-val').textContent = netTotal + ' Mbps';
  document.getElementById('kpi-net-bar').style.width = Math.min(100, netTotal * 10) + '%';

  document.getElementById('nav-cpu-pct').textContent = d.cpu + '%';
}

function setKPI(id, txt, pct) {
  document.getElementById('kpi-' + id + '-val').textContent = txt;
  const bar = document.getElementById('kpi-' + id + '-bar');
  bar.style.width = pct + '%';
  bar.style.background = colorForPct(pct);
}

function updateCharts() {
  if (!chartCpuRam) return;
  const labels = history.cpu.map((_, i) => i);

  chartCpuRam.data.labels = labels;
  chartCpuRam.data.datasets[0].data = [...history.cpu];
  chartCpuRam.data.datasets[1].data = [...history.ram];
  chartCpuRam.data.datasets[2].data = [...history.disk];
  chartCpuRam.data.datasets[0].hidden = !visible.cpu;
  chartCpuRam.data.datasets[1].hidden = !visible.ram;
  chartCpuRam.data.datasets[2].hidden = !visible.disk;
  chartCpuRam.update('none');

  chartNet.data.labels = labels;
  chartNet.data.datasets[0].data = [...history.net_dn];
  chartNet.data.datasets[1].data = [...history.net_up];
  chartNet.data.datasets[0].hidden = !visible.net;
  chartNet.data.datasets[1].hidden = !visible.net;
  chartNet.update('none');
}

function updateStats(d) {
  document.getElementById('st-proc').textContent = d.processes;
  document.getElementById('st-thr').textContent  = d.threads;
  document.getElementById('st-drd').innerHTML = d.disk_read + ' <span class="si-unit">MB/s</span>';
  document.getElementById('st-dwr').innerHTML = d.disk_write + ' <span class="si-unit">MB/s</span>';
}

/* =============================================================
   DISKS VIEW
   ============================================================= */
async function loadDisks(retries = 3) {
  const c = document.getElementById('disks-container');
  c.innerHTML = '<p style="color:var(--muted)">Cargando discos…</p>';
  try {
    const res = await fetch('/api/disks?sid=' + SID);
    const data = await res.json();
    if (!data.ok || !data.disks || !data.disks.length) {
      if (retries > 0) {
        setTimeout(() => loadDisks(retries - 1), 3000);
        return;
      }
      c.innerHTML = '<p style="color:var(--muted)">No se encontraron discos.</p>';
      return;
    }
    c.innerHTML = data.disks.map(dk => {
      let barClass = '';
      if (dk.used_pct >= 85) barClass = 'danger';
      else if (dk.used_pct >= 60) barClass = 'warn';

      return `
        <div class="disk-card">
          <div class="dk-top">
            <div class="dk-icon">💾</div>
            <div>
              <div class="dk-letter">${dk.letter}\\</div>
              <div class="dk-label">${dk.label}</div>
            </div>
            <span class="dk-fs">${dk.filesystem}</span>
          </div>
          <div class="dk-bar-wrap">
            <div class="dk-bar-fill ${barClass}" style="width:${dk.used_pct}%"></div>
          </div>
          <div class="dk-stats">
            <span>Usado: <strong>${dk.used_gb} GB</strong> (${dk.used_pct}%)</span>
            <span>Libre: <strong>${dk.free_gb} GB</strong></span>
            <span>Total: <strong>${dk.total_gb} GB</strong></span>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    c.innerHTML = '<p style="color:var(--danger)">Error al cargar discos</p>';
  }
}

/* =============================================================
   DHCP VIEW
   ============================================================= */
async function loadDhcp() {
  const c = document.getElementById('dhcp-container');
  c.innerHTML = '<p style="color:var(--muted)">Consultando servidor DHCP...</p>';
  try {
    const res = await fetch('/api/dhcp?sid=' + SID);
    const data = await res.json();
    
    if (!data.ok) {
        c.innerHTML = `<p style="color:var(--danger)">Error: ${data.error}</p>`;
        return;
    }
    if (!data.dhcp_installed) {
        c.innerHTML = `<div class="spec-card"><h3>Rol no detectado</h3><p style="color:var(--muted);margin-top:6px;">El servicio DHCP Server no está instalado o no se puede acceder a él en este servidor.</p></div>`;
        return;
    }
    if (data.scopes.length === 0) {
        c.innerHTML = `<p style="color:var(--muted)">No hay ámbitos (scopes) configurados en el servidor.</p>`;
        return;
    }

    c.innerHTML = data.scopes.map(s => {
      let barClass = '';
      if (s.pct_in_use >= 85) barClass = 'danger';
      else if (s.pct_in_use >= 60) barClass = 'warn';

      return `
        <div class="disk-card" style="cursor:pointer" onclick="openDhcpModal('${s.scope_id}', '${s.name}')">
          <div class="dk-top">
            <div class="dk-icon">🌐</div>
            <div>
              <div class="dk-letter">${s.scope_id}</div>
              <div class="dk-label">${s.name}</div>
            </div>
            <span class="dk-fs">Mask: ${s.subnet_mask}</span>
          </div>
          <div style="margin-bottom: 16px; font-size: 0.85rem; color: var(--muted); font-family: monospace;">
            Rango: ${s.start_range} — ${s.end_range}
          </div>
          <div class="dk-bar-wrap">
            <div class="dk-bar-fill ${barClass}" style="width:${s.pct_in_use}%"></div>
          </div>
          <div class="dk-stats">
            <span>En uso: <strong>${s.in_use}</strong> (${Number(s.pct_in_use).toFixed(2)}%)</span>
            <span>Libres: <strong>${s.free}</strong></span>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    c.innerHTML = '<p style="color:var(--danger)">Error al consultar DHCP</p>';
  }
}

/* =============================================================
   DHCP MODAL LOGIC
   ============================================================= */
function closeDhcpModal() {
  document.getElementById('dhcp-modal').classList.remove('active');
}

async function openDhcpModal(scopeId, scopeName) {
  document.getElementById('dhcp-modal-title').textContent = scopeName || 'Rango DHCP';
  document.getElementById('dhcp-modal-sub').textContent = 'Cargando direcciones IP...';
  
  const c = document.getElementById('ip-list-container');
  c.innerHTML = '<p style="color:var(--muted);text-align:center;margin-top:20px;">Consultando pool vía WinRM...</p>';
  
  document.getElementById('dhcp-modal').classList.add('active');

  try {
    const res = await fetch(`/api/dhcp/ips?sid=${SID}&scope=${encodeURIComponent(scopeId)}`);
    const data = await res.json();
    
    if (!data.ok) {
      c.innerHTML = `<p style="color:var(--danger);text-align:center;">Error: ${data.error}</p>`;
      return;
    }
    
    document.getElementById('dhcp-modal-sub').textContent = `Subred: ${scopeId} — ${data.ips.length} IPs totales`;
    
    c.innerHTML = data.ips.map(item => {
      const isFree = item.free;
      const statusIcon = isFree ? '✔️' : '❌';
      const statusClass = isFree ? 'free' : 'used';
      const statusText = isFree ? 'Disponible' : 'En uso';
      
      return `
        <div class="ip-item ${statusClass}">
          <span class="ip-str">${item.ip}</span>
          <span class="ip-status" title="${statusText}">${statusIcon}</span>
        </div>
      `;
    }).join('');
    
  } catch (e) {
    c.innerHTML = '<p style="color:var(--danger);text-align:center;">Error de red al consultar IPs</p>';
  }
}

/* =============================================================
   SPECS VIEW
   ============================================================= */
function renderSpecs() {
  const c = document.getElementById('specs-container');
  const s = SPECS;
  const ramGB = (parseFloat(s.ram_total_kb || 0) / (1024 * 1024)).toFixed(1);
  const diskGB = (parseFloat(s.disk_total_b || 0) / (1024 ** 3)).toFixed(1);

  c.innerHTML = `
    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(217,70,239,.15)">⚙️</div>
        <div>
          <div class="sp-title">Procesador</div>
          <div class="sp-sub">${s.cpu_name || '—'}</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">Núcleos físicos</span><span class="sr-val">${s.cpu_cores || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Procesadores lógicos</span><span class="sr-val">${s.cpu_logical || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Velocidad base</span><span class="sr-val">${s.cpu_speed || '—'} MHz</span></div>
      <div class="spec-row"><span class="sr-key">Caché L2</span><span class="sr-val">${s.cpu_l2_kb || '—'} KB</span></div>
      <div class="spec-row"><span class="sr-key">Caché L3</span><span class="sr-val">${s.cpu_l3_kb || '—'} KB</span></div>
      <div class="spec-row"><span class="sr-key">Virtualización</span><span class="sr-val">${s.cpu_virt === 'True' ? 'Habilitada' : 'Desconocida'}</span></div>
    </div>

    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(6,182,212,.15)">🧠</div>
        <div>
          <div class="sp-title">Memoria y Almacenamiento</div>
          <div class="sp-sub">Recursos del sistema</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">RAM instalada</span><span class="sr-val">${ramGB} GB</span></div>
      <div class="spec-row"><span class="sr-key">Disco C: total</span><span class="sr-val">${diskGB} GB</span></div>
    </div>

    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(108,92,231,.15)">🖥️</div>
        <div>
          <div class="sp-title">Sistema Operativo</div>
          <div class="sp-sub">${s.os_version || '—'}</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">Versión del SO</span><span class="sr-val">${s.os_version || '—'}</span></div>
    </div>
  `;
}

/* =============================================================
   Keyboard shortcuts
   ============================================================= */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLoginModal();
  if (e.key === 'Enter' && document.getElementById('login-modal').classList.contains('active')) doConnect();
});
