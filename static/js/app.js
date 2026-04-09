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
   HOME — Dynamic Server Cards
   ============================================================= */
document.addEventListener('DOMContentLoaded', () => loadServerCards());

async function loadServerCards() {
  const grid = document.getElementById('servers-grid');
  try {
    const res = await fetch('/api/servers');
    const data = await res.json();
    const servers = data.ok ? data.servers : [];

    let html = servers.map(s => `
      <div class="server-card" onclick="connectToServer(${s.id}, '${s.ip}')">
        <button class="sc-action sc-edit" title="Editar" onclick="event.stopPropagation(); openEditServerModal(${s.id}, '${s.alias.replace(/'/g, "\\'")}', '${s.ip}', '${s.username.replace(/'/g, "\\'")}')">
          ✏️
        </button>
        <button class="sc-action sc-delete" title="Eliminar" onclick="event.stopPropagation(); deleteServerCard(${s.id}, '${s.alias.replace(/'/g, "\\'")}')">
          🗑️
        </button>
        <div class="sc-icon">🖥️</div>
        <h3>${s.alias}</h3>
        <p class="sc-ip">${s.ip}</p>
        <div class="sc-status" id="srv-status-${s.id}">
          <span class="dot" style="background:#555; animation:none"></span> <span style="color:var(--muted)">Comprobando...</span>
        </div>
      </div>
    `).join('');

    html += `
      <div class="server-card add-card" onclick="openAddServerModal()">
        <div class="add-card-icon">＋</div>
        <h3>Agregar Servidor</h3>
        <p class="sc-ip" style="color:var(--muted)">Nuevo servidor WinRM</p>
      </div>
    `;
    grid.innerHTML = html;

    // Fetch status initially
    servers.forEach(checkServerStatus);

    // Keep checking every 10 seconds if home screen is visible
    if (window._statusInterval) clearInterval(window._statusInterval);
    window._statusInterval = setInterval(() => {
      const home = document.getElementById('home-screen');
      if (home && home.style.display !== 'none') {
        servers.forEach(checkServerStatus);
      }
    }, 10000);

  } catch (e) {
    grid.innerHTML = `
      <div class="server-card add-card" onclick="openAddServerModal()">
        <div class="add-card-icon">＋</div>
        <h3>Agregar Servidor</h3>
        <p class="sc-ip" style="color:var(--muted)">Nuevo servidor WinRM</p>
      </div>
    `;
  }
}

async function checkServerStatus(s) {
  try {
    const sr = await fetch('/api/servers/' + s.id + '/status');
    const sdata = await sr.json();
    const statDiv = document.getElementById('srv-status-' + s.id);
    if (!statDiv) return;

    if (sdata.ok && sdata.status === 'online') {
      statDiv.innerHTML = '<span class="dot" style="background:var(--ok)"></span> <span style="color:var(--ok)">Disponible para conexión</span>';
    } else {
      statDiv.innerHTML = '<span class="dot" style="background:var(--danger); animation:none"></span> <span style="color:var(--danger)">No disponible</span>';
    }
  } catch (e) {
    const statDiv = document.getElementById('srv-status-' + s.id);
    if (statDiv) statDiv.innerHTML = '<span class="dot" style="background:var(--danger); animation:none"></span> <span style="color:var(--danger)">No disponible</span>';
  }
}

/* =============================================================
   SERVER MODAL — Add / Edit
   ============================================================= */
function openAddServerModal() {
  document.getElementById('srv-edit-id').value = '';
  document.getElementById('srv-alias').value = '';
  document.getElementById('srv-ip').value = '';
  document.getElementById('srv-user').value = '';
  document.getElementById('srv-pwd').value = '';
  document.getElementById('srv-pwd').placeholder = '••••••••';
  document.getElementById('server-modal-title').textContent = 'Agregar Servidor';
  document.getElementById('server-modal-sub').textContent = 'Introduce los datos de conexión WinRM';
  document.getElementById('btn-save-text').textContent = 'Guardar Servidor';
  document.getElementById('server-modal-error').classList.remove('show');
  document.getElementById('server-modal').classList.add('active');
  document.getElementById('srv-alias').focus();
}

function openEditServerModal(id, alias, ip, user) {
  document.getElementById('srv-edit-id').value = id;
  document.getElementById('srv-alias').value = alias;
  document.getElementById('srv-ip').value = ip;
  document.getElementById('srv-user').value = user;
  document.getElementById('srv-pwd').value = '';
  document.getElementById('srv-pwd').placeholder = 'Dejar vacío para no cambiar';
  document.getElementById('server-modal-title').textContent = 'Editar Servidor';
  document.getElementById('server-modal-sub').textContent = 'Modifica los datos de "' + alias + '"';
  document.getElementById('btn-save-text').textContent = 'Guardar Cambios';
  document.getElementById('server-modal-error').classList.remove('show');
  document.getElementById('server-modal').classList.add('active');
  document.getElementById('srv-alias').focus();
}

function closeServerModal() {
  document.getElementById('server-modal').classList.remove('active');
  document.getElementById('server-modal-error').classList.remove('show');
}

async function saveServer() {
  const editId = document.getElementById('srv-edit-id').value;
  const alias = document.getElementById('srv-alias').value.trim();
  const ip = document.getElementById('srv-ip').value.trim();
  const user = document.getElementById('srv-user').value.trim();
  const pwd = document.getElementById('srv-pwd').value;
  const errBox = document.getElementById('server-modal-error');
  const btn = document.getElementById('btn-save-server');
  const spinner = document.getElementById('save-spinner');
  const btnTxt = document.getElementById('btn-save-text');

  if (!alias || !ip || !user) {
    errBox.textContent = 'Alias, IP y usuario son obligatorios';
    errBox.classList.add('show');
    return;
  }

  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (!ipRegex.test(ip)) {
    errBox.textContent = 'Formato de IP incorrecto. Debe ser una dirección IPv4 válida (ej. 192.168.1.10)';
    errBox.classList.add('show');
    return;
  }

  if (!editId && !pwd) {
    errBox.textContent = 'La contraseña es obligatoria para un servidor nuevo';
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnTxt.textContent = 'Guardando…';
  errBox.classList.remove('show');

  try {
    let url = '/api/servers';
    let method = 'POST';
    let body = { alias, ip, user, password: pwd };

    if (editId) {
      url = '/api/servers/' + editId;
      method = 'PUT';
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!data.ok) {
      errBox.textContent = data.error || 'Error al guardar';
      errBox.classList.add('show');
      return;
    }

    closeServerModal();
    loadServerCards();
  } catch (e) {
    errBox.textContent = 'Error de red al guardar';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnTxt.textContent = editId ? 'Guardar Cambios' : 'Guardar Servidor';
  }
}

let _serverToDelete = null;

function deleteServerCard(id, alias) {
  _serverToDelete = id;
  document.getElementById('confirm-modal').classList.add('active');
  document.getElementById('confirm-sub').textContent = `¿Eliminar el servidor "${alias}"?`;
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('active');
  _serverToDelete = null;
}

document.getElementById('btn-confirm-action').addEventListener('click', async () => {
  if (!_serverToDelete) return;
  const id = _serverToDelete;
  closeConfirmModal();
  try {
    await fetch('/api/servers/' + id, { method: 'DELETE' });
    loadServerCards();
  } catch (e) {
    alert('Error al eliminar');
  }
});

/* =============================================================
   CONNECT TO SERVER (by DB id)
   ============================================================= */
function closeConnectingModal() {
  document.getElementById('connecting-modal').classList.remove('active');
}

async function connectToServer(serverId, ip) {
  const modal = document.getElementById('connecting-modal');
  const errBox = document.getElementById('connecting-error');
  const spinner = document.getElementById('connecting-spinner');
  const iconErr = document.getElementById('connecting-icon-error');
  const closeBtn = document.getElementById('connect-close-btn');

  document.getElementById('connecting-title').textContent = 'Conectando…';
  document.getElementById('connecting-sub').textContent = 'Estableciendo sesión WinRM con ' + ip;
  errBox.classList.remove('show');
  spinner.style.display = 'inline-block';
  iconErr.style.display = 'none';
  closeBtn.style.display = 'none';
  modal.classList.add('active');

  const showError = (title, msg) => {
    document.getElementById('connecting-title').textContent = title;
    errBox.textContent = msg;
    errBox.classList.add('show');
    spinner.style.display = 'none';
    iconErr.style.display = 'block';
    closeBtn.style.display = 'block';
  };

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId })
    });
    const data = await res.json();

    if (!data.ok) {
      showError('Error de conexión', data.error || 'No se pudo conectar al servidor.');
      return;
    }

    SID = data.sid;
    SPECS = data.specs;
    modal.classList.remove('active');
    enterDashboard(ip);
  } catch (e) {
    showError('Error', 'No se pudo contactar con el backend (Servidor Web caído o inalcanzable).');
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
  _disksLoaded = false;
  _dhcpLoaded = false;

  // Clear previous server's modules to prevent data phantom crossover
  document.getElementById('disks-container').innerHTML = '';
  document.getElementById('specs-container').innerHTML = '';
  document.getElementById('dhcp-container').innerHTML = '';
  document.getElementById('ip-list-container').innerHTML = '';

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
      loadDhcp(); // Pre-load DHCP in the background seamlessly
      startPolling();
    }, 100);
  });
}

let _polling = false;

function startPolling() {
  if (POLL) clearTimeout(POLL);
  _pollLoop();
}

async function _pollLoop() {
  if (!SID) return;
  if (_polling) { POLL = setTimeout(_pollLoop, 200); return; }
  _polling = true;
  try {
    const res = await fetch('/api/metrics?sid=' + SID);
    const d = await res.json();
    if (!d.ok) { _polling = false; return; }

    pushHistory('cpu', d.cpu);
    pushHistory('ram', d.ram);
    pushHistory('disk', d.disk);
    pushHistory('net_up', d.sent_mbps);
    pushHistory('net_dn', d.recv_mbps);

    updateKPIs(d);
    updateCharts();
    updateStats(d);
  } catch (e) { /* retry next cycle */ }
  _polling = false;
  // Fire next poll 500ms after THIS one completes — no pile-up, no wasted time
  if (SID) POLL = setTimeout(_pollLoop, 500);
}

function doDisconnect() {
  if (POLL) clearTimeout(POLL);
  POLL = null;
  _polling = false;

  fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: SID })
  }).catch(() => { });

  SID = null;
  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = '';

  if (chartCpuRam) { chartCpuRam.destroy(); chartCpuRam = null; }
  if (chartNet) { chartNet.destroy(); chartNet = null; }
  IP_CACHE = {};

  // Refresh server cards on return to Home
  loadServerCards();
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
  if (chartNet) { chartNet.destroy(); chartNet = null; }

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
        { label: 'Disco %', data: [], borderColor: '#e3d0a9', backgroundColor: 'rgba(227,208,169,.1)', fill: true, borderWidth: 2, borderDash: [6, 3] }
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
        { label: 'Envío ↑', data: [], borderColor: '#f6cbcc', backgroundColor: 'rgba(246,203,204,.1)', fill: true, borderWidth: 2 }
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
  setKPI('cpu', d.cpu + '%', d.cpu);
  setKPI('ram', d.ram + '%', d.ram);
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
  document.getElementById('st-thr').textContent = d.threads;
  document.getElementById('st-drd').innerHTML = d.disk_read + ' <span class="si-unit">MB/s</span>';
  document.getElementById('st-dwr').innerHTML = d.disk_write + ' <span class="si-unit">MB/s</span>';
}

/* =============================================================
   DISKS VIEW
   ============================================================= */
let _disksLoaded = false;
async function loadDisks(force = false) {
  if (!force && _disksLoaded) return;
  
  const c = document.getElementById('disks-container');
  if (c.innerHTML.trim() === '') {
    c.innerHTML = '<p style="color:var(--muted)">Cargando discos…</p>';
  }

  try {
    const res = await fetch('/api/disks?sid=' + SID);
    const data = await res.json();
    if (!data.ok || !data.disks || !data.disks.length) {
      c.innerHTML = '<p style="color:var(--muted)">No se encontraron discos.</p>';
      return;
    }
    
    _disksLoaded = true;

    // Smooth DOM update to preserve transitions
    let html = '';
    data.disks.forEach(dk => {
      let barClass = '';
      if (dk.used_pct >= 90) barClass = 'danger';
      else if (dk.used_pct >= 80) barClass = 'warn';
      else barClass = 'success';

      const hlth = dk.health || 'Unknown';
      const mtype = dk.media_type || 'Desconocido';
      const healthColor = (hlth === 'Healthy') ? 'var(--ok)' : (hlth === 'Warning' ? 'var(--warn)' : 'var(--danger)');

      const colorMap = { 'success': 'var(--ok)', 'warn': 'var(--yellow)', 'danger': 'var(--danger)' };
      const chartColor = colorMap[barClass];

      // We maintain smooth updates by rewriting the innerHTML of a wrapper only or rebuilding entirely?
      // Since innerHTML recreates nodes, we will check if the card exists by ID.
      let existing = document.getElementById('disk-card-' + dk.letter.replace(':', ''));
      if (existing) {
        existing.querySelector('.dk-bar-fill').className = 'dk-bar-fill ' + barClass;
        existing.querySelector('.dk-bar-fill').style.width = dk.used_pct + '%';
        existing.querySelector('.doughnut-chart').style.background = `conic-gradient(${chartColor} ${dk.used_pct}%, rgba(255,255,255,0.05) 0)`;
        existing.querySelector('.doughnut-inner').textContent = dk.used_pct + '%';
        existing.querySelector('.dk-stats').innerHTML = `
            <span>Usado: <strong style="color:var(--cream);font-size:0.95rem">${Number(dk.used_gb).toFixed(2)} GB (${dk.used_pct}%)</strong></span>
            <span>Libre: <strong style="font-size:0.95rem">${Number(dk.free_gb).toFixed(2)} GB</strong></span>
            <span>Total: <strong>${Number(dk.total_gb).toFixed(2)} GB</strong></span>
          `;
      } else {
        html += `
          <div class="disk-card" id="disk-card-${dk.letter.replace(':', '')}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="flex:1">
                <div class="dk-top">
                  <div class="dk-icon">💾</div>
                  <div>
                    <div class="dk-letter">${dk.letter}\\</div>
                    <div class="dk-label">${dk.label}</div>
                  </div>
                  <span class="dk-fs">${dk.filesystem}</span>
                </div>
                <div style="display:flex; gap:10px; margin-bottom:12px; font-size:0.75rem;">
                  <span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:4px; color:var(--cream); border:1px solid rgba(255,255,255,0.15)">
                     ${mtype}
                  </span>
                  <span style="background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px; color:${healthColor}; font-weight:600; border:1px solid ${healthColor}55">
                     ❤ ${hlth}
                  </span>
                </div>
              </div>
              <div style="margin-left:15px; flex-shrink:0;">
                <div class="doughnut-chart" style="background: conic-gradient(${chartColor} ${dk.used_pct}%, rgba(255,255,255,0.05) 0);">
                  <div class="doughnut-inner">${dk.used_pct}%</div>
                </div>
              </div>
            </div>
            <div class="dk-bar-wrap">
              <div class="dk-bar-fill ${barClass}" style="width:${dk.used_pct}%"></div>
            </div>
            <div class="dk-stats">
              <span>Usado: <strong style="color:var(--cream);font-size:0.95rem">${Number(dk.used_gb).toFixed(2)} GB (${dk.used_pct}%)</strong></span>
              <span>Libre: <strong style="font-size:0.95rem">${Number(dk.free_gb).toFixed(2)} GB</strong></span>
              <span>Total: <strong>${Number(dk.total_gb).toFixed(2)} GB</strong></span>
            </div>
          </div>`;
      }
    });

    if (html !== '') {
      if (c.innerHTML.indexOf('disk-card') === -1) c.innerHTML = html;
      else c.innerHTML += html; // Add any new disks
    }
  } catch (e) {
    c.innerHTML = '<p style="color:var(--danger)">Error al cargar discos</p>';
  }
}

/* =============================================================
   DHCP VIEW
   ============================================================= */
let IP_CACHE = {};
let _dhcpLoaded = false;

async function loadDhcp(force = false) {
  if (!force && _dhcpLoaded) return;
  IP_CACHE = {}; // Clear IP cache when refreshing DHCP scopes
  const c = document.getElementById('dhcp-container');
  if (c.innerHTML.trim() === '') {
    c.innerHTML = '<p style="color:var(--muted)">Consultando servidor DHCP...</p>';
  }
  try {
    const res = await fetch('/api/dhcp?sid=' + SID);
    const data = await res.json();

    if (!data.ok) {
      c.innerHTML = `<p style="color:var(--danger)">Error: ${data.error}</p>`;
      return;
    }
    _dhcpLoaded = true;
    
    if (!data.dhcp_installed) {
      c.innerHTML = `<div class="spec-card"><h3>Rol no detectado</h3><p style="color:var(--muted);margin-top:6px;">El servicio DHCP Server no está instalado o no se puede acceder a él en este servidor.</p></div>`;
      return;
    }
    if (data.scopes.length === 0) {
      c.innerHTML = `<p style="color:var(--muted)">No hay ámbitos (scopes) configurados en el servidor.</p>`;
      return;
    }

    let html = '';
    data.scopes.forEach(s => {
      let barClass = '';
      if (s.pct_in_use >= 85) barClass = 'danger';
      else if (s.pct_in_use >= 60) barClass = 'warn';
      else barClass = 'success';

      let existing = document.getElementById('dhcp-card-' + s.scope_id.replace(/\./g, '_'));
      if (existing) {
        existing.querySelector('.dk-bar-fill').className = 'dk-bar-fill ' + barClass;
        existing.querySelector('.dk-bar-fill').style.width = s.pct_in_use + '%';
        existing.querySelector('.dk-stats').innerHTML = `
            <span>En uso: <strong style="color:var(--cream);font-size:0.95rem">${s.in_use} (${Number(s.pct_in_use).toFixed(2)}%)</strong></span>
            <span>Libres: <strong style="font-size:0.95rem">${s.free}</strong></span>
          `;
      } else {
        html += `
            <div class="disk-card" id="dhcp-card-${s.scope_id.replace(/\./g, '_')}" style="cursor:pointer" onclick="openDhcpModal('${s.scope_id}', '${s.name}')">
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
                <span>En uso: <strong style="color:var(--cream);font-size:0.95rem">${s.in_use} (${Number(s.pct_in_use).toFixed(2)}%)</strong></span>
                <span>Libres: <strong style="font-size:0.95rem">${s.free}</strong></span>
              </div>
            </div>`;
      }
    });

    if (html !== '') {
      if (c.innerHTML.indexOf('disk-card') === -1) c.innerHTML = html;
      else c.innerHTML += html;
    }
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
  
  if (IP_CACHE[scopeId]) {
    document.getElementById('dhcp-modal-sub').textContent = IP_CACHE[scopeId].subText;
    c.innerHTML = IP_CACHE[scopeId].html;
    document.getElementById('dhcp-modal').classList.add('active');
    return;
  }

  c.innerHTML = '<p style="color:var(--muted);text-align:center;margin-top:20px;">Consultando pool vía WinRM...</p>';
  document.getElementById('dhcp-modal').classList.add('active');

  try {
    const res = await fetch(`/api/dhcp/ips?sid=${SID}&scope=${encodeURIComponent(scopeId)}`);
    const data = await res.json();

    if (!data.ok) {
      c.innerHTML = `<p style="color:var(--danger);text-align:center;">Error: ${data.error}</p>`;
      return;
    }

    let subText = `Subred: ${scopeId} — ${data.total} IPs totales`;
    if (data.truncated) {
        subText += " (Limitado a 1000 iteraciones para no bloquear el navegador)";
    }
    document.getElementById('dhcp-modal-sub').textContent = subText;

    c.innerHTML = '<div class="ip-list-grid">' + data.ips.map(item => {
      const isFree = !item.in_use;
      const statusIcon = isFree ? '✅' : '❌';
      const statusClass = isFree ? 'free' : 'used';
      const statusText = isFree ? 'Libre' : 'En uso';

      return `
        <div class="ip-item ${statusClass}">
          <span class="ip-str">${item.ip}</span>
          <span class="ip-status" title="${statusText}">${statusIcon}</span>
        </div>
      `;
    }).join('') + '</div>';

    IP_CACHE[scopeId] = {
      subText: subText,
      html: c.innerHTML
    };

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

  let cpuHtml = `
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
  `;

  if (s.cpu_l2_kb && s.cpu_l2_kb !== '0') {
    cpuHtml += `<div class="spec-row"><span class="sr-key">Caché L2</span><span class="sr-val">${s.cpu_l2_kb} KB</span></div>`;
  }
  if (s.cpu_l3_kb && s.cpu_l3_kb !== '0') {
    cpuHtml += `<div class="spec-row"><span class="sr-key">Caché L3</span><span class="sr-val">${s.cpu_l3_kb} KB</span></div>`;
  }

  const v = s.cpu_virt === 'True' ? 'Habilitada' : 'Desconocida';
  if (v !== 'Desconocida') {
    cpuHtml += `<div class="spec-row"><span class="sr-key">Virtualización</span><span class="sr-val">${v}</span></div>`;
  }

  cpuHtml += `</div>`;

  let netAdaptersHtml = '';
  if (s.net_adapters && s.net_adapters.length > 0) {
    netAdaptersHtml = s.net_adapters.map(n => `
          <div style="margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05);">
              <div style="font-weight:700; color:var(--cream); font-size:0.9rem; margin-bottom:6px">${n.desc}</div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">IPv4</span><span class="sr-val" style="font-size:0.8rem">${n.ip}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">MAC</span><span class="sr-val" style="font-size:0.8rem">${n.mac}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">Gateway</span><span class="sr-val" style="font-size:0.8rem">${n.gw}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">DNS</span><span class="sr-val" style="font-size:0.8rem">${n.dns}</span></div>
          </div>
      `).join('');
  } else {
    netAdaptersHtml = `<p style="color:var(--muted); font-size:0.85rem">No se detectaron adaptadores activos (IPEnabled)</p>`;
  }

  let memHtml = `
    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(6,182,212,.15)">🧠</div>
        <div>
          <div class="sp-title">Memoria y Almacenamiento</div>
          <div class="sp-sub">Recursos principales</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">Fabricante del sist.</span><span class="sr-val">${s.manufacturer || 'Desconocido'}</span></div>
      <div class="spec-row"><span class="sr-key">RAM instalada</span><span class="sr-val">${ramGB} GB</span></div>
  `;
  if (s.ram_speed && s.ram_speed !== '0' && s.ram_speed !== 'Desconocida') {
    memHtml += `<div class="spec-row"><span class="sr-key">Velocidad RAM</span><span class="sr-val">${s.ram_speed} MHz</span></div>`;
  }
  memHtml += `
      <div class="spec-row"><span class="sr-key">Disco C: total</span><span class="sr-val">${diskGB} GB</span></div>
    </div>
  `;

  c.innerHTML = cpuHtml + memHtml + `
    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(108,92,231,.15)">🖥️</div>
        <div>
          <div class="sp-title">Sistema Operativo</div>
          <div class="sp-sub">${s.os_version || '—'}</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">Uptime</span><span class="sr-val">${s.uptime || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Hostname</span><span class="sr-val">${s.hostname || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">${s.domain_role || 'Red'}</span><span class="sr-val">${s.domain || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Versión del SO</span><span class="sr-val">${s.os_version || '—'}</span></div>
    </div>

    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(52,211,153,.15)">🛜</div>
        <div>
          <div class="sp-title">Red y Conectividad</div>
          <div class="sp-sub">Interfaces IPv4 activas</div>
        </div>
      </div>
      ${netAdaptersHtml}
    </div>
  `;
}

/* =============================================================
   Keyboard shortcuts
   ============================================================= */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeServerModal();
    closeDhcpModal();
  }
  if (e.key === 'Enter' && document.getElementById('server-modal').classList.contains('active')) saveServer();
});
