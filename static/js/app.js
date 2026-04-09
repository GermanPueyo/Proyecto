/* =============================================================
   WinRM Server Monitor — Frontend Logic
   ============================================================= */

let SID = null;
let SPECS = {};
let POLL = null;
const MAX_PTS = 100; // Increased points for smoother look

const history = {
  cpu: [], ram: [], disk: [],
  net_up: [], net_dn: []
};

let chartCpuRam = null;
let chartNet = null;
let visible = { cpu: true, ram: true, disk: true, net: true };

/* =============================================================
   HOME — Dynamic Server Cards & Drag & Drop
   ============================================================= */
document.addEventListener('DOMContentLoaded', () => loadServerCards());

// Persist open groups in localStorage
const savedGroups = localStorage.getItem('openedGroups');
let OPEN_GROUPS = new Set(savedGroups ? JSON.parse(savedGroups) : ['General']);

function saveGroupState() {
  localStorage.setItem('openedGroups', JSON.stringify([...OPEN_GROUPS]));
}

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, function(m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
  });
}

async function loadServerCards() {
  const grid = document.getElementById('servers-grid');
  try {
    const res = await fetch('/api/servers');
    const data = await res.json();
    if (!data.ok) return;

    let html = '';
    const groups = data.groups || [];

    if (groups.length === 0) {
      grid.innerHTML = `
        <div class="server-group empty">
          <div class="group-header">
            <div class="group-title">Sin grupos configurados</div>
          </div>
          <div class="group-content" style="opacity:1; min-height:100px; display:flex; align-items:center; justify-content:center;">
             <p style="color:var(--muted)">Haz clic en "Gestionar Grupos" para empezar</p>
          </div>
        </div>
      `;
      return;
    }

    groups.forEach(group => {
      const gName = escapeHTML(group.name);
      const gid = group.id;
      const servers = group.servers || [];
      const isClosed = !OPEN_GROUPS.has(group.name);
      const isEmpty = servers.length === 0;
      
      html += `
        <div class="server-group ${isClosed ? 'closed' : ''} ${isEmpty ? 'is-ghost' : ''}" 
             id="group-container-${gid}" data-gid="${gid}" data-group-name="${gName}">
          <div class="group-header" onclick="toggleGroup(this.parentElement)">
            <div class="group-title">
              <span class="group-chevron">▼</span>
              ${gName} <span class="count">${servers.length}</span>
            </div>
          </div>
          <div class="group-content" data-gid="${gid}">
            ${servers.map(s => {
              const m = s.metrics || {};
              const isOnline = m.status === 'online';
              const cpu = m.cpu || 0;
              const disk = m.disk || 0;
              const isAlert = cpu >= 80 || disk >= 80;
              const alias = escapeHTML(s.alias);
              const tagsRaw = s.tags ? s.tags.split(',').map(t => t.trim()).filter(t => t) : [];
              
              return `
                <div class="mini-card ${isAlert ? 'status-alert' : ''} ${!isOnline ? 'status-offline' : ''}" 
                     data-sid="${s.id}"
                     onclick="connectToServer(${s.id}, '${s.ip}')">
                  <div class="mc-actions">
                    <button class="mc-btn" title="Editar" onclick="event.stopPropagation(); openEditServerModal(${s.id}, '${alias.replace(/'/g, "\\'")}', '${s.ip}', '${escapeHTML(s.username).replace(/'/g, "\\'")}', ${gid}, '${escapeHTML(s.tags || '').replace(/'/g, "\\'")}')">✏️</button>
                    <button class="mc-btn" title="Eliminar" onclick="event.stopPropagation(); deleteServerCard(${s.id}, '${alias.replace(/'/g, "\\'")}')">🗑️</button>
                  </div>
                  <div class="mc-info">
                    <h3>${alias}</h3>
                    <div class="mc-ip">${s.ip}</div>
                    <div class="server-tags">
                      ${tagsRaw.map(t => `<span class="tag-badge">${escapeHTML(t)}</span>`).join('')}
                    </div>
                  </div>
                  ${isOnline ? `
                  <div class="mc-bars">
                    <div class="mc-bar-item">
                      <span>CPU</span>
                      <div class="mc-bar-wrap">
                        <div class="mc-bar-fill" style="width:${cpu}%; background:${colorForPct(cpu)}"></div>
                      </div>
                      <span style="width:25px; text-align:right">${cpu}%</span>
                    </div>
                    <div class="mc-bar-item">
                      <span>DSK</span>
                      <div class="mc-bar-wrap">
                        <div class="mc-bar-fill" style="width:${disk}%; background:${colorForPct(disk)}"></div>
                      </div>
                      <span style="font-size:0.6rem; min-width:60px; text-align:right">
                        ${m.used_gb != null ? m.used_gb + '/' + m.total_gb + ' GB' : disk + '%'}
                      </span>
                    </div>
                  </div>
                  ` : `
                  <div style="margin-top:10px; font-size:0.7rem; color:var(--danger); font-weight:600">
                    DESCONECTADO
                  </div>
                  `}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;
    initSortable();

  } catch (e) {
    console.error("Error loading NOC dashboard:", e);
  }
}

// Global Refresh Interval (Syncs every 10s)
if (window._statusInterval) clearInterval(window._statusInterval);
window._statusInterval = setInterval(() => {
  const home = document.getElementById('home-screen');
  if (home && home.style.display !== 'none' && !window._isDragging) {
    loadServerCards(); 
  }
}, 10000);

function initSortable() {
  const grid = document.getElementById('servers-grid');
  
  // 1. Sortable for Groups
  new Sortable(grid, {
    animation: 150,
    handle: '.group-header',
    ghostClass: 'sortable-ghost',
    onStart: () => { window._isDragging = true; },
    onEnd: async (evt) => {
      window._isDragging = false;
      const order = [...grid.children].map((el, i) => ({
        id: parseInt(el.dataset.gid),
        position: i
      }));
      
      try {
        await fetch('/api/groups/reorder', {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ order })
        });
      } catch (e) {
        console.error("Failed to reorder groups:", e);
      }
    }
  });

  // 2. Sortable for Servers within groups
  document.querySelectorAll('.group-content').forEach(el => {
    new Sortable(el, {
      group: 'shared-servers', // Allow moving across groups
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      onStart: () => { window._isDragging = true; },
      onEnd: async (evt) => {
        window._isDragging = false;
        const sid = evt.item.dataset.sid;
        const newGid = evt.to.dataset.gid;
        const newPos = evt.newIndex;
        
        // Optimistic UI Update: Instant count and ghost toggle
        updateUIStats();

        try {
          await fetch('/api/servers/move', {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ server_id: parseInt(sid), group_id: parseInt(newGid), position: newPos })
          });
        } catch (e) {
          console.error("Failed to move server:", e);
          loadServerCards(); // Revert on failure
        }
      }
    });
  });
}

/**
 * Updates group counts and ghost states instantly based on DOM state
 */
function updateUIStats() {
  document.querySelectorAll('.server-group').forEach(group => {
    const content = group.querySelector('.group-content');
    const countSpan = group.querySelector('.group-count');
    if (!content || !countSpan) return;

    const currentCount = content.querySelectorAll('.mini-card').length;
    countSpan.textContent = currentCount;

    if (currentCount === 0) {
      group.classList.add('is-ghost');
    } else {
      group.classList.remove('is-ghost');
    }
  });
}

function toggleGroup(el) {
  const gName = el.getAttribute('data-group-name');
  if (el.classList.contains('closed')) {
    el.classList.remove('closed');
    OPEN_GROUPS.add(gName);
  } else {
    el.classList.add('closed');
    OPEN_GROUPS.delete(gName);
  }
  saveGroupState();
}

/* =============================================================
   GROUP MANAGEMENT MODAL
   ============================================================= */
async function openGroupsModal() {
  document.getElementById('groups-modal').classList.add('active');
  loadGroupsList();
}
function closeGroupsModal() {
  document.getElementById('groups-modal').classList.remove('active');
  loadServerCards();
}

async function loadGroupsList() {
  const container = document.getElementById('groups-list-container');
  const res = await fetch('/api/groups');
  const data = await res.json();
  if (!data.ok) return;

  container.innerHTML = data.groups.map(g => `
    <div class="group-mgmt-item">
      <div class="gm-drag-handle">≡</div>
      <input type="text" value="${g.name}" class="gm-input" 
             onchange="renameGroup(${g.id}, this.value)"
             onkeydown="if(event.key==='Enter') { this.blur(); renameGroup(${g.id}, this.value); }">
      <button class="gm-delete-btn" title="Eliminar Grupo" onclick="deleteGroup(${g.id})">🗑️</button>
    </div>
  `).join('');
}

async function createNewGroup() {
  const name = document.getElementById('new-group-name').value;
  if (!name) return;
  await fetch('/api/groups', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name })
  });
  document.getElementById('new-group-name').value = '';
  loadGroupsList();
}

async function renameGroup(gid, name) {
  await fetch(`/api/groups/${gid}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name })
  });
}

async function deleteGroup(gid) {
  if (!confirm('¿Borrar grupo? Los servidores se moverán a "General".')) return;
  await fetch(`/api/groups/${gid}`, { method: 'DELETE' });
  loadGroupsList();
}

function filterServers(val) {
  const search = val.toLowerCase().trim();
  const grid = document.getElementById('servers-grid');
  const groups = document.querySelectorAll('.server-group');

  if (search === "") {
    grid.classList.remove('is-searching');
    groups.forEach(g => {
      g.style.display = 'block';
      g.querySelectorAll('.mini-card').forEach(c => c.style.display = 'flex');
    });
    return;
  }

  grid.classList.add('is-searching');
  groups.forEach(group => {
    const cards = group.querySelectorAll('.mini-card');
    let hasVisible = false;

    cards.forEach(card => {
      const text = card.innerText.toLowerCase();
      const match = text.includes(search);
      card.style.display = match ? 'flex' : 'none';
      if (match) hasVisible = true;
    });

    // Hide/Show the group container
    group.style.display = hasVisible ? 'block' : 'none';
  });
}

/* =============================================================
   SERVER MODAL — Add / Edit
   ============================================================= */
async function fetchGroupsIntoSelect(selectedId = null) {
  const select = document.getElementById('srv-group-select');
  if (!select) return;
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    if (data.ok) {
      select.innerHTML = data.groups.map(g => `
        <option value="${g.id}" ${selectedId == g.id ? 'selected' : ''}>${g.name}</option>
      `).join('');
    }
  } catch (e) {
    console.error("Error fetching groups for select:", e);
  }
}

async function openAddServerModal(defaultGid = null) {
  document.getElementById('srv-edit-id').value = '';
  document.getElementById('srv-alias').value = '';
  document.getElementById('srv-ip').value = '';
  document.getElementById('srv-tags').value = '';
  document.getElementById('srv-user').value = '';
  document.getElementById('srv-pwd').value = '';
  document.getElementById('srv-pwd').placeholder = '••••••••';
  document.getElementById('server-modal-title').textContent = 'Agregar Servidor';
  document.getElementById('server-modal-sub').textContent = 'Introduce los datos de conexión WinRM';
  document.getElementById('btn-save-text').textContent = 'Guardar Servidor';
  document.getElementById('server-modal-error').classList.remove('show');
  
  await fetchGroupsIntoSelect(defaultGid);
  
  document.getElementById('server-modal').classList.add('active');
  document.getElementById('srv-alias').focus();
}

async function openEditServerModal(id, alias, ip, user, gid, tags) {
  document.getElementById('srv-edit-id').value = id;
  document.getElementById('srv-alias').value = alias;
  document.getElementById('srv-ip').value = ip;
  document.getElementById('srv-user').value = user;
  document.getElementById('srv-tags').value = tags || '';
  document.getElementById('srv-pwd').value = '';
  document.getElementById('srv-pwd').placeholder = 'Dejar vacío para no cambiar';
  document.getElementById('server-modal-title').textContent = 'Editar Servidor';
  document.getElementById('server-modal-sub').textContent = 'Modifica los datos de "' + alias + '"';
  document.getElementById('btn-save-text').textContent = 'Guardar Cambios';
  document.getElementById('server-modal-error').classList.remove('show');
  
  await fetchGroupsIntoSelect(gid);
  
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
  const groupId = document.getElementById('srv-group-select').value;
  const tags = document.getElementById('srv-tags').value.trim();
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
    errBox.textContent = 'Formato de IP incorrecto. Debe ser una dirección IPv4 válida';
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

  try {
    let url = '/api/servers';
    let method = 'POST';
    let body = { 
      alias, ip, username: user, password: pwd, 
      group_id: parseInt(groupId), tags: tags 
    };

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
    
    // Set Dashboard Context for polling
    const contextEl = document.getElementById('dashboard-context');
    if (contextEl) contextEl.setAttribute('data-server-id', serverId);
    
    console.log("🚀 Connection Success. Server ID Context set to:", serverId);
    
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

  // PROACTIVE LOADING: Load all sub-modules immediately on entry
  renderSpecs();
  loadDisks();   // Now automatic
  loadDhcp();    // Now automatic

  // Defer chart init to next frame so the browser has laid out the DOM
  requestAnimationFrame(() => {
    setTimeout(() => {
      initCharts();
      setupKpiToggles();
      startPolling();
    }, 100);
  });
}

let _polling = false;

let _pollActive = false; 

function startPolling() {
  console.log("🚀 [POLL] Iniciando motor de monitorización...");
  if (_pollActive) return; 
  _pollActive = true;
  _runHeartbeat();
}

async function _runHeartbeat() {
  if (!SID || !_pollActive) {
    _pollActive = false;
    return;
  }

  const contextEl = document.getElementById('dashboard-context');
  const serverId = contextEl ? contextEl.getAttribute('data-server-id') : 'unknown';

  try {
    const res = await fetch(`/api/metrics?sid=${SID}&server_id=${serverId}`);
    if (!res.ok) throw new Error();
    const d = await res.json();
    
    if (d && d.ok && d.status !== 'loading') { 
      if (d.specs && document.getElementById('specs-container').innerHTML === '') {
        IP_CACHE = d.specs; 
        renderSpecs();
      }

      pushHistory('cpu', d.cpu || 0);
      pushHistory('ram', d.ram || 0);
      pushHistory('disk', d.disk || 0);
      pushHistory('net_up', (d.sent_mbps !== undefined) ? d.sent_mbps : 0);
      pushHistory('net_dn', (d.recv_mbps !== undefined) ? d.recv_mbps : 0);

      updateKPIs(d);
      updateCharts();
      updateStats(d);
    }
  } catch (e) { 
    // Silently handle transient errors for a smoother experience
  } finally {
    if (SID && _pollActive) {
      POLL = setTimeout(_runHeartbeat, 900);
    }
  }
}

function doDisconnect() {
  console.log("🧹 [SESSION] Disconnecting & Purging state...");
  _pollActive = false; 
  if (POLL) clearTimeout(POLL);
  POLL = null;

  fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: SID })
  }).catch(() => { });

  SID = null;
  SPECS = {};
  IP_CACHE = {};

  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = '';

  if (chartCpuRam) { chartCpuRam.destroy(); chartCpuRam = null; }
  if (chartNet) { chartNet.destroy(); chartNet = null; }

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
  const cpu = Math.round(d.cpu || 0);
  const ram = Math.round(d.ram || 0);
  const disk = (d.disk !== undefined) ? Number(d.disk).toFixed(1) : 0;

  setKPI('cpu', cpu + '%', cpu);
  setKPI('ram', ram + '%', ram);
  setKPI('disk', disk + '%', disk);

  const netTotal = (Number(d.recv_mbps || 0) + Number(d.sent_mbps || 0)).toFixed(1);
  document.getElementById('kpi-net-val').textContent = netTotal + ' Mbps';
  document.getElementById('kpi-net-bar').style.width = Math.min(100, netTotal * 10) + '%';

  if (document.getElementById('nav-cpu-pct')) {
    document.getElementById('nav-cpu-pct').textContent = cpu + '%';
  }
}

function setKPI(id, txt, pct) {
  const valEl = document.getElementById('kpi-' + id + '-val');
  if (valEl) valEl.textContent = txt;
  const bar = document.getElementById('kpi-' + id + '-bar');
  if (bar) {
    bar.style.width = pct + '%';
    bar.style.background = colorForPct(parseFloat(pct));
  }
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
   SPECS VIEW — Dynamic Hardware Details
   ============================================================= */
function formatUptime(raw) {
  if (!raw || raw.length < 14) return 'Desconocido';
  try {
    const y = parseInt(raw.substring(0,4)), m = parseInt(raw.substring(4,6))-1, d = parseInt(raw.substring(6,8));
    const hh = parseInt(raw.substring(8,10)), mm = parseInt(raw.substring(10,12)), ss = parseInt(raw.substring(12,14));
    const boot = new Date(y, m, d, hh, mm, ss);
    const diff = (new Date() - boot) / 1000;
    
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    
    let res = [];
    if (days > 0) res.push(`${days}d`);
    if (hours > 0) res.push(`${hours}h`);
    res.push(`${mins}m`);
    return res.join(' ');
  } catch(e) { return 'Calculando...'; }
}

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
              <div style="font-weight:700; color:var(--cream); font-size:0.9rem; margin-bottom:6px">${n.Description || 'Adaptador'}</div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">IPv4</span><span class="sr-val" style="font-size:0.8rem">${n.IP || '—'}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">MAC</span><span class="sr-val" style="font-size:0.8rem">${n.MACAddress || '—'}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">Gateway</span><span class="sr-val" style="font-size:0.8rem">${n.GW || '—'}</span></div>
              <div class="spec-row" style="border:none; padding:4px 0"><span class="sr-key" style="font-size:0.8rem">DNS</span><span class="sr-val" style="font-size:0.8rem">${n.DNS || '—'}</span></div>
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

  const uptime = formatUptime(s.raw_uptime);

  c.innerHTML = cpuHtml + memHtml + `
    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(108,92,231,.15)">🖥️</div>
        <div>
          <div class="sp-title">Sistema Operativo</div>
          <div class="sp-sub">${s.os_version || 'Detectado'}</div>
        </div>
      </div>
      <div class="spec-row"><span class="sr-key">Uptime</span><span class="sr-val">${uptime}</span></div>
      <div class="spec-row"><span class="sr-key">Hostname</span><span class="sr-val">${s.hostname || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Red</span><span class="sr-val">${s.domain || '—'}</span></div>
      <div class="spec-row"><span class="sr-key">Versión del SO</span><span class="sr-val">Detectado</span></div>
    </div>
    <div class="spec-card">
      <div class="sp-header">
        <div class="sp-icon" style="background:rgba(59,130,246,.15)">🌐</div>
        <div>
          <div class="sp-title">Red y Conectividad</div>
          <div class="sp-sub">Interfaces IPv4 activas</div>
        </div>
      </div>
      <div style="margin-top:15px">
        ${netAdaptersHtml}
      </div>
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
