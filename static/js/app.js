/* =============================================================
   WinRM Server Monitor — Frontend Logic
   ============================================================= */

let SID = null;
let SPECS = {};
let ISOLATED_GROUP = null; // New state for isolating a single group
let POLL = null;
const MAX_PTS = 100; // Increased points for smoother look

const history = {
  cpu: [], ram: [], disk: [],
  net_up: [], net_dn: []
};

let chartCpuRam = null;
let chartNet = null;
let visible = { cpu: true, ram: true, disk: true, net: true };
let LOG_TO_DELETE = null; // Global for deletion flow
let H_THR_CRIT = 85;
let H_THR_WARN = 70;
let H_FLTR = null; // critical, warning, null
let LAST_FLEET_DATA = []; // To store full server info for heatmap
let _fleet_metrics_cache = {}; // Global for real-time updates
let logCurrentPage = 1; // Pagination state for logs

/* =============================================================
   HOME — Dynamic Server Cards & Drag & Drop
   ============================================================= */
document.addEventListener('DOMContentLoaded', () => {
    // Immediate first load
    loadServerCards();
    // Fast second pulse for NOC data (allows agent cache to populate)
    setTimeout(loadServerCards, 1500);
    // Auto-populate DHCP table on startup without user interaction
    setTimeout(async () => {
        try {
            await fetch('/api/fleet/dhcp/refresh', { method: 'POST' });
            loadServerCards();
        } catch(e) { /* silently ignore */ }
    }, 2500);
    
    // START REAL-TIME ALERT TUNNEL (SSE)
    initRealTimeAlerts();
    // Initialize Heatmap Grid (40 placeholders)
    initHeatmapGrid();
});

/**
 * SSE TUNNEL: Listen for high-urgency agent reports and update UI instantly
 */
function initRealTimeAlerts() {
  console.log("⚡ INICIANDO TUNEL DE EMERGENCIAS (SSE)...");
  const evtSource = new EventSource("/api/alerts/stream");

  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'agent_update') {
      console.log(`🚀 ALERTA RECIBIDA DE AGENTE (ID: ${data.server_id}). Actualizando Dashboard y Logs...`);
      // Instant refresh of the dashboard (this also calls updateGlobalDhcpTable internally)
      loadServerCards();
      // Fast refresh of logs if the user is in that view
      if (document.getElementById('view-logs').style.display !== 'none') {
        loadAlertLogs();
      }
      // Instant refresh of Heatmap
      renderHeatmap();
    }
  };

  evtSource.onerror = (err) => {
    console.warn("⚠️ Perdiendo conexión con el túnel de emergencias. Rearmando...");
    evtSource.close();
    setTimeout(initRealTimeAlerts, 5000); // Auto-reconnect after 5s
  };
}

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

let CURRENT_FLTR = JSON.parse(localStorage.getItem('serverFltr')) || { mode: 'none', dir: 'desc' };
let RESOURCE_FLTR = null; // New state for filtering alerts by resource

function toggleFilter(metric) {
  if (CURRENT_FLTR.mode === metric) {
    if (CURRENT_FLTR.dir === 'desc') {
      CURRENT_FLTR.dir = 'asc';
    } else {
      CURRENT_FLTR.mode = 'none'; // Toggle off
    }
  } else {
    CURRENT_FLTR.mode = metric;
    CURRENT_FLTR.dir = 'desc';
  }
  localStorage.setItem('serverFltr', JSON.stringify(CURRENT_FLTR));
  loadServerCards();
}

/**
 * Updates the visual state of the filter pills
 */
function updatePillUI() {
  document.querySelectorAll('.pill-btn').forEach(btn => {
    const metric = btn.id.replace('fltr-', '');
    const span = btn.querySelector('span');
    btn.classList.remove('active-desc', 'active-asc');
    if (span) span.textContent = '';

    if (CURRENT_FLTR.mode === metric) {
      if (CURRENT_FLTR.dir === 'desc') {
        btn.classList.add('active-desc');
        if (span) span.textContent = '↓';
      } else {
        btn.classList.add('active-asc');
        if (span) span.textContent = '↑';
      }
    }
  });
}

async function loadServerCards() {
  const grid = document.getElementById('servers-grid');
  updatePillUI();

  try {
    const res = await fetch('/api/servers');
    const data = await res.json();
    if (!data || !data.groups) return;

    const rawGroups = data.groups || [];
    LAST_FLEET_DATA = rawGroups;
    
    // SYNC SIDEBAR & KPI (Must be first to populate internal counts)
    if (typeof updateNocDashboard === 'function') updateNocDashboard(rawGroups);
    
    // SYNC HEATMAP
    renderHeatmap();
    
    // SYNC GLOBAL DHCP TABLE — runs always, no button click needed
    updateGlobalDhcpTable(rawGroups);
    
    // Update Groups Sidebar
    if (typeof updateNocDashboard === 'function') updateNocDashboard(rawGroups);

    let groups = [...rawGroups];

    // IMPLEMENT ISOLATION FOR THE MAIN GRID ONLY
    if (ISOLATED_GROUP) {
      groups = groups.filter(g => String(g.id) === String(ISOLATED_GROUP));
    }

    let html = '';

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
      let servers = group.servers || [];

      // DYNAMIC SORTING LOGIC
    servers.sort((a, b) => {
          const ma = a.metrics || {};
          const mb = b.metrics || {};
          
          // ABSOLUTE RULE 1: Online > Offline
          const statusA = ma.status === 'online' ? 1 : 0;
          const statusB = mb.status === 'online' ? 1 : 0;
          if (statusA !== statusB) return statusB - statusA;

          // If both are offline, keep alphabetical
          if (statusA === 0) return a.alias.localeCompare(b.alias);

          // ABSOLUTE RULE 2: If both online, use current filter or default to 'critical'
          const mode = CURRENT_FLTR.mode === 'none' ? 'critical' : CURRENT_FLTR.mode;
          const dir = CURRENT_FLTR.dir === 'desc' ? 1 : -1;

          if (mode === 'cpu') {
              return dir * ((mb.cpu || 0) - (ma.cpu || 0));
          } else if (mode === 'disk') {
              return dir * ((mb.disk || 0) - (ma.disk || 0));
          } else {
              // 'critical' mode: Hybrid score of CPU and Disk
              const scoreA = (ma.cpu || 0) + (ma.disk || 0);
              const scoreB = (mb.cpu || 0) + (mb.disk || 0);
              if (scoreA !== scoreB) {
                  return dir * (scoreB - scoreA);
              }
          }
          // Tie-break: Alphabetical
          return a.alias.localeCompare(b.alias);
      });

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
                     style="cursor: default">
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
                      <span>RAM</span>
                      <div class="mc-bar-wrap">
                        <div class="mc-bar-fill" style="width:${m.ram || 0}%; background:${colorForPct(m.ram || 0)}"></div>
                      </div>
                      <span style="width:25px; text-align:right">${(m.ram || 0).toFixed(0)}%</span>
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
                    ${m.dhcp && m.dhcp !== 'error' ? `
                    <div class="mc-bar-item">
                      <span>DHC</span>
                      <div class="mc-bar-wrap">
                        <div class="mc-bar-fill" style="width:${m.dhcp.pct}%; background:var(--blue)"></div>
                      </div>
                      <span style="width:25px; text-align:right">${m.dhcp.pct}%</span>
                    </div>
                    ` : ''}
                  </div>
                  ` : `
                  <div style="margin-top:10px; font-size:0.7rem; color:var(--danger); font-weight:600; display:flex; flex-direction:column; gap:2px;">
                    <div>${m.status === 'shutting_down' ? '🛑 APAGANDO...' : '❌ DESCONECTADO'}</div>
                    ${s.last_seen ? `<div style="font-size:0.6rem; opacity:0.5; font-weight:400;">Last: ${s.last_seen}</div>` : ''}
                  </div>
                  `}
                  <div class="source-indicator" style="position:absolute; bottom:5px; right:8px; font-size:0.55rem; opacity:0.3; text-transform:uppercase;">
                    ${m.source === 'agent' ? '⚡ Agente' : '☁️ Polling'}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;
    initSortable();
    
    // Redundant call removed - dashboard already updated above
  } catch (e) {
    console.error("Error loading server cards:", e);
  }
}

/**
 * NOC LOGIC: Calculates global health and generates alerts
 */
function updateNocDashboard(groups) {
    let serversTotal = 0;
    let counts = { cpu: 0, ram: 0, disk: 0 };
    let alerts = [];
    let groupLinksHtml = '';

    groups.forEach(group => {
        groupLinksHtml += `<div class="nav-item" onclick="scrollToGroup('${group.id}')"><span>📂</span> ${escapeHTML(group.name)}</div>`;
        (group.servers || []).forEach(s => {
            serversTotal++;
            const m = s.metrics || {};
            const sId = s.id;
            const sIp = s.ip;

            if (m.status === 'online') {
                const cpu = m.cpu || 0;
                const ram = m.ram || 0;
                const disk = m.disk || 0;

                if (cpu > 80) {
                    counts.cpu++;
                    alerts.push({ res: 'cpu', type: 'emergency', title: s.alias, sid: sId, ip: sIp, desc: `CPU Crítica: ${cpu.toFixed(1)}%` });
                }
                if (ram > 80) {
                    counts.ram++;
                    alerts.push({ res: 'ram', type: 'emergency', title: s.alias, sid: sId, ip: sIp, desc: `RAM Crítica: ${ram.toFixed(1)}%` });
                }
                if (disk > 80) {
                    counts.disk++;
                    alerts.push({ res: 'disk', type: 'emergency', title: s.alias, sid: sId, ip: sIp, desc: `Disco casi lleno: ${disk}%` });
                }

                // Global DHCP Alert logic
                if (m.dhcp && m.dhcp.pct >= 85) {
                    if (!counts.dhcp) counts.dhcp = 0;
                    counts.dhcp++;
                    alerts.push({ res: 'dhcp', type: 'warn', title: s.alias, sid: sId, ip: sIp, desc: `DHCP Saturado: ${m.dhcp.pct}% de IPs usadas` });
                }
            }
        });
    });

    // 0. Update Global DHCP Summary Table
    updateGlobalDhcpTable(groups);

    // 1. Update 3 Cyclograms
    const circ = 283;
    const totalSafe = serversTotal || 1;
    
    ['cpu', 'ram', 'disk', 'dhcp'].forEach(res => {
        const ring = document.getElementById(`ring-${res}`);
        const valText = document.getElementById(`status-${res}-val`);
        const container = document.getElementById(`ciclo-${res}-container`);
        
        if (ring && valText) {
            const count = counts[res] || 0;
            const pct = count / totalSafe;
            
            // Clean UI: Hide the ring if there are 0 critical cases
            if (count === 0) {
                ring.style.stroke = 'transparent';
                ring.style.strokeDasharray = `0 ${circ}`;
            } else {
                ring.style.stroke = res === 'dhcp' ? 'var(--blue)' : 'var(--danger)';
                ring.style.strokeDasharray = `${circ * pct} ${circ}`;
            }
            ring.style.strokeDashoffset = 0;
            valText.textContent = count;

            if (RESOURCE_FLTR === res) container.classList.add('active');
            else container.classList.remove('active');
        }
    });

    // 2. Update Alerts Panel (Filtered by Resource)
    const alertList = document.getElementById('global-alerts');
    const alertBadge = document.getElementById('alert-count-badge');
    if (alertList) {
        let displayAlerts = alerts;
        if (RESOURCE_FLTR) {
            displayAlerts = alerts.filter(a => a.res === RESOURCE_FLTR);
        }

        if (displayAlerts.length === 0) {
            alertList.innerHTML = `<div style="text-align:center; padding:40px; opacity:0.3;"><div style="font-size:2rem; margin-bottom:10px;">🛡️</div><p style="font-size:0.75rem;">No hay alertas activas de este tipo.</p></div>`;
            alertBadge.textContent = '0';
        } else {
            alertBadge.textContent = displayAlerts.length;
            alertList.innerHTML = displayAlerts.map(a => `
                <div class="alert-card ${a.type}" style="cursor: default">
                    <div class="alert-header">
                        <span>🚨 ${a.res.toUpperCase()}</span>
                        <span>Crítico</span>
                    </div>
                    <div class="alert-title">${escapeHTML(a.title)}</div>
                    <div class="alert-desc">${a.desc}</div>
                </div>
            `).join('');
        }
    }

    // 3. Update Nav Groups
    const navGroups = document.getElementById('nav-groups-list');
    if (navGroups) navGroups.innerHTML = groupLinksHtml;
}

function toggleResourceFilter(res) {
    if (RESOURCE_FLTR === res) RESOURCE_FLTR = null;
    else RESOURCE_FLTR = res;
    
    // Refresh UI immediately
    loadServerCards();
}

function scrollToGroup(gid) {
    // Apply isolation: we only want to see this group
    ISOLATED_GROUP = gid;
    
    // Switch to servers view
    switchNocTab('servers');
    
    // Reload cards with isolation active
    loadServerCards();
}

function switchNocTab(tab) {
    // Hidden sections
    const healthView = document.getElementById('health-center-overview');
    const serversView = document.getElementById('noc-servers-view');
    const logsView = document.getElementById('view-logs');
    const dhcpView = document.getElementById('global-dhcp-summary');
    
    // Nav items
    const navHome = document.getElementById('nav-noc-home');
    const navServers = document.getElementById('nav-noc-servers');
    const navLogs = document.getElementById('nav-noc-logs');
    const navDhcp = document.getElementById('nav-noc-dhcp');

    // 1. Force home screen visibility if we were in a dashboard
    const homeScreen = document.getElementById('home-screen');
    const dashScreen = document.getElementById('dashboard-screen');
    if (dashScreen && dashScreen.style.display !== 'none') {
        dashScreen.style.display = 'none';
        homeScreen.style.display = 'block';
        _pollActive = false; 
        SID = null; 
    }

    // 2. Clear NOC states (don't hide dhcpView yet, let the tab logic decide)
    const healthHeader = document.querySelector('.health-center');
    const heatmapView = document.getElementById('noc-heatmap-view');
    
    if(healthView) healthView.style.display = 'none';
    if(serversView) serversView.style.display = 'none';
    if(logsView) logsView.style.display = 'none';
    
    // Default restore (Home/Dashboard view)
    if(healthHeader) healthHeader.style.display = 'flex';
    if(heatmapView) {
        heatmapView.style.display = 'flex';
        // Remove DHCP-only margin adjustments if they exist
        heatmapView.style.marginTop = '20px';
        heatmapView.style.background = 'rgba(0,0,0,0.15)';
    }
    
    // 3. Reset Sidebar Classes
    if(navHome) navHome.classList.remove('active');
    if(navServers) navServers.classList.remove('active');
    if(navLogs) navLogs.classList.remove('active');
    if(navDhcp) navDhcp.classList.remove('active');

    // 4. Activate Tab
    if (tab === 'home') {
        if(healthView) healthView.style.display = 'block';
        if(navHome) navHome.classList.add('active');
        restoreHeatmapVisuals();
        ISOLATED_GROUP = null;
        loadServerCards(); 
    } else if (tab === 'servers') {
        if(serversView) serversView.style.display = 'block';
        if(navServers) navServers.classList.add('active');
        restoreHeatmapVisuals();
        loadServerCards();
    } else if (tab === 'logs') {
        if(logsView) {
            logsView.style.display = 'block';
            if(navLogs) navLogs.classList.add('active');
            loadAlertLogs(1);
        }
    } else if (tab === 'dhcp-global') {
        // Show Health view container but hide internal Home-specific blocks
        if(healthView) healthView.style.display = 'block';
        if(navDhcp) navDhcp.classList.add('active');
        
        // Hide TOP Cyclograms and Heatmap components for a clean DHCP list
        if(healthHeader) healthHeader.style.display = 'none';
        
        if(heatmapView) {
            // We keep the heatmapView container because DHCP summary is INSIDE it, 
            // but we hide its internal heatmap-specific children to "purify" the view
            const titleBlock = heatmapView.querySelector('div:first-child');
            const gridBlock = document.getElementById('heatmap-grid');
            const controlsBlock = document.getElementById('heatmap-controls');
            const legendBlock = document.getElementById('heatmap-legend');
            
            if(titleBlock) titleBlock.style.display = 'none';
            if(gridBlock) gridBlock.style.display = 'none';
            if(controlsBlock) controlsBlock.style.display = 'none';
            if(legendBlock) legendBlock.style.display = 'none';
            
            // Adjust container for DHCP-only mode
            heatmapView.style.marginTop = '0';
            heatmapView.style.background = 'transparent';
            heatmapView.style.border = 'none';
            heatmapView.style.padding = '0';
        }

        if(dhcpView) {
            dhcpView.style.display = 'block';
            dhcpView.scrollIntoView({ behavior: 'smooth' });
        }
    }
}

// Helper to restore heatmap children (needed when switching back from DHCP)
function restoreHeatmapVisuals() {
    const heatmapView = document.getElementById('noc-heatmap-view');
    if(!heatmapView) return;
    
    const titleBlock = heatmapView.querySelector('div:first-child');
    const gridBlock = document.getElementById('heatmap-grid');
    const controlsBlock = document.getElementById('heatmap-controls');
    const legendBlock = document.getElementById('heatmap-legend');
    
    if(titleBlock) titleBlock.style.display = 'flex';
    if(gridBlock) gridBlock.style.display = 'grid';
    if(controlsBlock) controlsBlock.style.display = 'flex';
    if(legendBlock) legendBlock.style.display = 'flex';
    
    heatmapView.style.marginTop = '20px';
    heatmapView.style.background = 'rgba(0,0,0,0.15)';
    heatmapView.style.border = '1px solid rgba(255,255,255,0.05)';
    heatmapView.style.padding = '24px';
}

async function loadAlertLogs(page = 1) {
    const tbody = document.getElementById('logs-tbody');
    const pagination = document.getElementById('logs-pagination');
    if(!tbody) return;
    
    logCurrentPage = page;
    
    // Mostramos un mini-spinner o aviso de carga sin borrar todo el alto
    tbody.style.opacity = '0.5';
    
    try {
        const res = await fetch(`/api/logs?page=${page}&per_page=10`);
        const data = await res.json();
        
        tbody.style.opacity = '1';

        if (!data.ok || data.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--muted)">No hay registros históricos.</td></tr>';
            if(pagination) pagination.innerHTML = '';
            return;
        }

        const logs = data.logs;
        tbody.innerHTML = logs.map(l => {
            const start = l.timestamp ? new Date(l.timestamp) : null;
            const end = l.end_timestamp ? new Date(l.end_timestamp) : null;
            
            // we use the pre-formatted strings from Python to avoid timezone hell
            const startDisplay = l.timestamp_str;
            const endDisplay = l.end_timestamp_str;

            let durationStr = l.duration_str;
            if (durationStr === 'Activo') {
                durationStr = '<span class="pulse-active">Activo</span>';
            }

            let valClass = '';
            if (l.metric_type === 'STATUS') valClass = 'tag-status';
            else if (l.value >= 80) valClass = 'tag-critical';

            let avgVal = l.value_avg;
            if (avgVal === null && l.sample_count > 0) {
                avgVal = l.value_sum / l.sample_count;
            }

            return `
                <tr id="log-row-${l.id}">
                    <td>${startDisplay}</td>
                    <td>${endDisplay}</td>
                    <td style="font-weight:600">${durationStr}</td>
                    <td style="font-weight:600">${escapeHTML(l.server_name)}</td>
                    <td><span class="log-tag">${l.metric_type}</span></td>
                    <td style="color:var(--muted)">${avgVal ? avgVal.toFixed(1) + '%' : '—'}</td>
                    <td><span class="${valClass}">${l.value > 0 ? l.value.toFixed(1) + '%' : '—'}</span></td>
                    <td style="text-align:right">
                      <button class="mc-btn" style="opacity:0.4" onclick="deleteAlertLog(${l.id})">🗑️</button>
                    </td>
                </tr>
            `;
        }).join('');

        renderPagination(data.current_page, data.pages);
    } catch(e) {
        tbody.style.opacity = '1';
        console.error("Error loading logs:", e);
    }
}

function renderPagination(current, total) {
    const container = document.getElementById('logs-pagination');
    if (!container) return;

    let html = '';
    
    // Info text
    html += `<span style="font-size: 0.75rem; color: var(--muted); margin-right: auto;">Página ${current} de ${total}</span>`;

    // Previous Button
    html += `<button class="btn btn-ghost mini" ${current === 1 ? 'disabled' : ''} onclick="loadAlertLogs(${current - 1})">Anterior</button>`;

    // Page Numbers (limited to 5 for clean UI)
    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(total, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="pill-btn mini ${i === current ? 'active-desc' : ''}" style="min-width:30px" onclick="loadAlertLogs(${i})">${i}</button>`;
    }

    // Next Button
    html += `<button class="btn btn-ghost mini" ${current === total ? 'disabled' : ''} onclick="loadAlertLogs(${current + 1})">Siguiente</button>`;

    container.innerHTML = html;
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('active');
    LOG_TO_DELETE = null;
}

function clearAllLogs() {
    LOG_TO_DELETE = 'all';
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    modal.querySelector('h2').textContent = '¿Limpiar historial?';
    modal.querySelector('.modal-sub').textContent = 'Se borrarán TODOS los registros permanentemente.';
    modal.classList.add('active');
    setupConfirmClick();
}

async function deleteAlertLog(id) {
    LOG_TO_DELETE = id;
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    modal.querySelector('h2').textContent = '¿Eliminar registro?';
    modal.querySelector('.modal-sub').textContent = 'Esta acción no se puede deshacer.';
    modal.classList.add('active');
    setupConfirmClick();
}

function setupConfirmClick() {
    const btn = document.getElementById('confirm-delete-btn');
    if (!btn) return;
    btn.onclick = async () => {
        try {
            const isAll = LOG_TO_DELETE === 'all';
            const url = isAll ? '/api/logs' : `/api/logs/${LOG_TO_DELETE}`;
            const res = await fetch(url, { method: 'DELETE' });
            if (res.ok) {
                if (isAll) {
                    const tbody = document.getElementById('logs-tbody');
                    if (tbody) {
                        Array.from(tbody.children).forEach(row => {
                            row.style.opacity = '0';
                            row.style.transform = 'translateX(20px)';
                        });
                        setTimeout(() => {
                            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--muted)">No hay registros históricos.</td></tr>';
                        }, 300);
                    }
                } else {
                    const row = document.getElementById(`log-row-${LOG_TO_DELETE}`);
                    if (row) {
                        row.style.opacity = '0';
                        row.style.transform = 'translateX(20px)';
                        setTimeout(() => {
                            row.remove();
                            const tbody = document.getElementById('logs-tbody');
                            if (tbody && tbody.children.length === 0) {
                                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--muted)">No hay registros históricos.</td></tr>';
                            }
                        }, 300);
                    }
                }
            }
            closeConfirmModal();
        } catch (e) {
            console.error("Error deleting log:", e);
        }
    };
}

// Global helper to reset isolation
function showAllServers() {
    ISOLATED_GROUP = null;
    switchNocTab('servers');
}

// Global Refresh Interval (Syncs every 10s)
if (window._statusInterval) clearInterval(window._statusInterval);
window._statusInterval = setInterval(() => {
  const home = document.getElementById('home-screen');
  if (home && home.style.display !== 'none' && !window._isDragging) {
    loadServerCards(); 
  }
}, 30000);

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
      onMove: (evt) => {
          // If hovering over a closed group, open it automatically
          const targetGroup = evt.to.closest('.server-group');
          if (targetGroup && targetGroup.classList.contains('closed')) {
              if (window._openTimer) clearTimeout(window._openTimer);
              window._openTimer = setTimeout(() => {
                  if (targetGroup.classList.contains('closed')) {
                      toggleGroup(targetGroup);
                  }
              }, 150); // Reduced delay for instant UX
          }
      },
      onEnd: async (evt) => {
        if (window._openTimer) clearTimeout(window._openTimer);
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
  const grid = document.getElementById('servers-grid');
  document.querySelectorAll('.server-group').forEach(group => {
    const content = group.querySelector('.group-content');
    const countSpan = group.querySelector('.count'); // Corrected selector (was .group-count)
    if (!content || !countSpan) return;

    const currentCount = content.querySelectorAll('.mini-card').length;
    countSpan.textContent = currentCount;

    if (currentCount === 0) {
      group.classList.add('is-ghost');
      // Auto-move to bottom of the grid if not already there
      if (grid && group.nextElementSibling) {
          grid.appendChild(group);
      }
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
  // FORCE REFRESH: Sync dashboard layout with the new group order immediately
  loadServerCards();
}

async function loadGroupsList() {
  const container = document.getElementById('groups-list-container');
  const res = await fetch('/api/groups');
  const data = await res.json();
  if (!data.ok) return;

  container.innerHTML = data.groups.map(g => `
    <div class="group-mgmt-item" data-id="${g.id}">
      <div class="gm-drag-handle">≡</div>
      <input type="text" value="${escapeHTML(g.name)}" class="gm-input" 
             onchange="renameGroup(${g.id}, this.value)"
             onkeydown="if(event.key==='Enter') { this.blur(); renameGroup(${g.id}, this.value); }">
      <button class="gm-delete-btn" title="Eliminar Grupo" onclick="deleteGroup(${g.id})">🗑️</button>
    </div>
  `).join('');

  // Initialize sortable for groups management modal
  new Sortable(container, {
    animation: 200,
    handle: '.gm-drag-handle',
    onEnd: async () => {
      const order = [...container.children].map((el, i) => ({
        id: parseInt(el.dataset.id),
        position: i
      }));
      await fetch('/api/groups/reorder', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ order })
      });
    }
  });
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
    closeBtn.onclick = () => {
      if (connAbortController) connAbortController.abort();
      modal.classList.remove('active');
    };
    closeBtn.style.display = 'block';
  };

  if (connAbortController) connAbortController.abort();
  connAbortController = new AbortController();

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId }),
      signal: connAbortController.signal
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
    if (e.name === 'AbortError') return console.log("Connection canceled.");
    showError('Error', 'No se pudo contactar con el backend (Servidor Web caído o inalcanzable).');
  } finally {
    connAbortController = null;
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
      POLL = setTimeout(_runHeartbeat, 700);
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
  const modal = document.getElementById('dhcp-modal');
  const title = document.getElementById('dhcp-modal-title');
  const sub = document.getElementById('dhcp-modal-sub');
  const container = document.getElementById('ip-list-container');
  
  if (!modal || !container) return;

  title.textContent = scopeName || 'Rango DHCP';
  sub.textContent = 'Cargando direcciones IP...';

  // Check cache (using a simple global object if not defined)
  if (typeof IP_CACHE === 'undefined') window.IP_CACHE = {};
  
  if (IP_CACHE[scopeId]) {
    sub.textContent = IP_CACHE[scopeId].subText;
    container.innerHTML = IP_CACHE[scopeId].html;
    modal.classList.add('active');
    return;
  }

  container.innerHTML = `
    <div style="grid-column: 1/-1; text-align:center; padding:40px;">
        <div class="login-spinner" style="display:inline-block; width:30px; height:30px;"></div>
        <p style="margin-top:15px; font-size:0.8rem; color:var(--muted);">Consultando pool vía WinRM...</p>
    </div>
  `;
  modal.classList.add('active');

  try {
    const res = await fetch(`/api/dhcp/ips?sid=${SID}&scope=${encodeURIComponent(scopeId)}`);
    const data = await res.json();

    if (!data.ok) {
      container.innerHTML = `<p style="color:var(--danger);text-align:center;padding:20px;">Error: ${data.error}</p>`;
      return;
    }

    const subText = `Rango detectado: ${data.total} IPs totales`;
    sub.textContent = subText;
    
    let ipHtml = '';
    data.ips.forEach(ip => {
      const color = ip.in_use ? 'var(--danger)' : 'var(--ok)';
      const label = ip.in_use ? 'OCUPADA' : 'LIBRE';
      ipHtml += `
        <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; display:flex; justify-content:space-between; align-items:center; border:1px solid rgba(255,255,255,0.03)">
          <span style="font-family:'JetBrains Mono', monospace; font-size:0.85rem; color:var(--cream)">${ip.ip}</span>
          <span style="font-size:0.6rem; font-weight:800; color:${color}; opacity:0.8;">${label}</span>
        </div>
      `;
    });

    if (data.truncated) {
      ipHtml += `<div style="grid-column: 1/-1; background:rgba(255,150,0,0.1); color:var(--warn); padding:10px; border-radius:6px; font-size:0.7rem; text-align:center;">
          ⚠️ Listado truncado a 1000 IPs por rendimiento.
      </div>`;
    }

    container.innerHTML = ipHtml;
    IP_CACHE[scopeId] = { subText, html: ipHtml };

  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger);text-align:center;padding:20px;">Error de red al consultar IPs</p>';
  }
}

async function loadDhcp(force = false) {
  const container = document.getElementById('dhcp-container');
  if (_dhcpLoaded && !force) return;
  
  try {
    const res = await fetch(`/api/dhcp?sid=${SID}`);
    const data = await res.json();
    
    if (!data.ok) {
        container.innerHTML = `<p style="color:var(--danger)">Error: ${data.error || 'No se pudo cargar'}</p>`;
        return;
    }
    
    if (!data.scopes || data.scopes.length === 0) {
        container.innerHTML = '<p style="color:var(--muted)">No se detectaron ámbitos DHCP en este servidor.</p>';
        return;
    }
    
    container.innerHTML = data.scopes.map(s => {
        const pct = s.Percentage || 0;
        const barClass = pct > 90 ? 'danger' : (pct > 75 ? 'warn' : 'success');
        const statusColor = barClass === 'danger' ? 'var(--danger)' : (barClass === 'warn' ? 'var(--warn)' : 'var(--ok)');
        
        return `
            <div class="dhcp-card">
                <div class="dhcp-header">
                    <div class="dhcp-icon">🌐</div>
                    <div>
                        <div class="dhcp-scope-name">${s.Name || 'Sin nombre'}</div>
                        <div class="dhcp-scope-id">${s.ScopeId}</div>
                    </div>
                    <div class="dhcp-pct" style="color:${statusColor}">${pct}%</div>
                </div>
                
                <div class="dhcp-bar-wrap">
                    <div class="dhcp-bar-fill ${barClass}" style="width:${pct}%"></div>
                </div>
                
                <div class="dhcp-stats">
                    <div class="dhcp-stat-box">
                        <span class="dhcp-label">Utilizadas</span>
                        <span class="dhcp-val" style="color:var(--cream)">${s.InUse}</span>
                    </div>
                    <div class="dhcp-stat-box">
                        <span class="dhcp-label">Disponibles</span>
                        <span class="dhcp-val" style="color:var(--ok)">${s.Free}</span>
                    </div>
                    <div class="dhcp-stat-box">
                        <span class="dhcp-label">Reservas</span>
                        <span class="dhcp-val" style="color:var(--blue)">${s.Reserved}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    _dhcpLoaded = true;
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger)">Error crítico al conectar con el servidor DHCP.</p>';
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
    if (connAbortController) {
       connAbortController.abort();
       const m = document.getElementById('connecting-modal');
       if (m) m.classList.remove('active');
    }
    closeServerModal();
    closeDhcpModal();
  }
  if (e.key === 'Enter' && document.getElementById('server-modal').classList.contains('active')) saveServer();
});

/**
 * HEATMAP LOGIC — Enterprise Fleet Matrix (Flexible)
 */
function initHeatmapGrid() {
    // We no longer need 40 placeholders, the grid will be dynamic
    renderHeatmap();
}

function updateThresholds() {
    H_THR_CRIT = parseInt(document.getElementById('thr-crit').value);
    H_THR_WARN = parseInt(document.getElementById('thr-warn').value);
    
    document.getElementById('val-thr-crit').textContent = H_THR_CRIT;
    document.getElementById('val-thr-warn').textContent = H_THR_WARN;
    
    renderHeatmap();
}

function toggleHeatmapFilter(status) {
    if(H_FLTR === status) H_FLTR = null;
    else H_FLTR = status;
    
    // Update UI pills
    document.querySelectorAll('#heatmap-filters .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === H_FLTR);
    });
    
    renderHeatmap();
}

async function renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    if(!grid) return;

    // Flatten all servers from groups
    const servers = [];
    LAST_FLEET_DATA.forEach(group => {
        (group.servers || []).forEach(s => {
            servers.push({ ...s, groupName: group.name });
        });
    });

    if (servers.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--muted)">No hay servidores registrados.</div>';
        return;
    }

    let critCount = 0;
    let warnCount = 0;
    let html = '';

    servers.forEach(s => {
        // Fallback to empty object if cache or metrics are null
        const m = (typeof _fleet_metrics_cache !== 'undefined' ? _fleet_metrics_cache[s.id] : null) || s.metrics || {};
        const isOnline = m.status === 'online';
        const cpu = m.cpu || 0;
        const ram = m.ram || 0;
        const maxM = Math.max(cpu, ram);
        
        let state = 'normal';
        if(!isOnline) state = 'offline';
        else if(maxM >= H_THR_CRIT) { state = 'critical'; critCount++; }
        else if(maxM >= H_THR_WARN) { state = 'warning'; warnCount++; }
        
        // Filter logic
        let isVisible = true;
        if(H_FLTR === 'critical' && state !== 'critical') isVisible = false;
        if(H_FLTR === 'warning' && state !== 'warning') isVisible = false;

        if (isVisible) {
            html += `
                <div class="hm-block ${state}" title="${s.alias} (${s.ip})" onclick="scrollToGroup('${s.group_id}')">
                    <span class="hm-group">${s.groupName}</span>
                    <span class="hm-id">${s.alias}</span>
                    <span class="hm-status-text">${isOnline ? maxM + '%' : 'OFF'}</span>
                </div>
            `;
        }
    });

    grid.innerHTML = html;
    document.getElementById('count-h-crit').textContent = critCount;
    document.getElementById('count-h-warn').textContent = warnCount;
}

/**
 * GLOBAL DHCP SUMMARY LOGIC
 */
function updateGlobalDhcpTable(groups) {
    const tableBody = document.getElementById('global-dhcp-table-body');
    const container = document.getElementById('global-dhcp-summary');
    if (!tableBody || !container) return;

    let hasServers = false;
    let tableHtml = '';

    groups.forEach(group => {
        (group.servers || []).forEach(s => {
            hasServers = true;
            const m = s.metrics || {};
            
            // Si el servidor está apagado o sin datos
            if (m.status !== 'online') {
                tableHtml += `
                    <tr style="opacity:0.5;">
                        <td style="font-weight:700; color:var(--muted);">${escapeHTML(s.alias)}</td>
                        <td><span style="font-family:'JetBrains Mono', monospace; font-size:0.8rem;">-</span></td>
                        <td style="text-align:center;">-</td>
                        <td style="text-align:center;">-</td>
                        <td style="text-align:center;">-</td>
                        <td style="text-align:center; color:var(--muted); font-size:0.75rem;">Desconectado</td>
                    </tr>
                `;
            } 
            // Si no tiene DHCP o dio error
            else if (!m.dhcp || m.dhcp === 'none' || m.dhcp === 'error') {
                let label = 'SIN SERVICIO DHCP';
                if (m.dhcp_error && m.dhcp_error !== 'none') {
                    label = m.dhcp_error.replace('error:', '').toUpperCase();
                    if (label.length > 20) label = label.substring(0, 20) + '...';
                }
                tableHtml += `
                    <tr>
                        <td style="font-weight:700; color:var(--cream);">${escapeHTML(s.alias)}</td>
                        <td><span style="font-family:'JetBrains Mono', monospace; opacity:0.6; font-size:0.8rem;">N/A</span></td>
                        <td style="text-align:center; color:var(--muted); opacity:0.5;">-</td>
                        <td style="text-align:center; color:var(--muted); opacity:0.5;">-</td>
                        <td style="text-align:center; color:var(--muted); opacity:0.5;">-</td>
                        <td style="text-align:center; color:var(--muted); font-size:0.65rem; font-weight:700; padding:8px;">
                            <span style="background:rgba(255,255,255,0.05); padding:4px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.1);" title="${m.dhcp_error || ''}">${label}</span>
                        </td>
                    </tr>
                `;
            } 
            // Si funciona correctamente
            else {
                const pct = m.dhcp.pct;
                const free = m.dhcp.free || 0;
                const used = m.dhcp.in_use || 0; 

                const state = pct >= 90 ? 'critical' : (pct >= 75 ? 'warning' : 'normal');
                const textColor = state === 'critical' ? 'var(--danger)' : (state === 'warning' ? 'var(--warn)' : 'var(--ok)');

                const scopeId = m.dhcp.scope_id || "Global";
                const scopeName = m.dhcp.scope_name || "Flota Global";
                
                tableHtml += `
                    <tr>
                        <td style="font-weight:700; color:var(--cream);">${escapeHTML(s.alias)}</td>
                        <td><span style="font-family:'JetBrains Mono', monospace; color:var(--accent); font-size:0.8rem;">${escapeHTML(scopeName)}</span></td>
                        <td style="color:${textColor}; font-weight:800; text-align:center;">${pct}%</td>
                        <td style="text-align:center; color:var(--ok); font-family:'JetBrains Mono', monospace; font-weight:600;">${free}</td>
                        <td style="text-align:center; color:var(--danger); font-family:'JetBrains Mono', monospace; font-weight:600;">${used}</td>
                        <td style="text-align:center;">
                            <button class="pill-btn mini" 
                                onclick="openGlobalDhcpIps(${s.id}, '${escapeHTML(scopeId)}', '${escapeHTML(s.alias).replace(/'/g, "\\'")}')"
                                style="font-size:0.65rem; padding:4px 12px; border:1px solid var(--blue); background:rgba(131,180,187,0.1);">
                                🔍 VER IPs
                            </button>
                        </td>
                    </tr>
                `;
            }
        });
    });

    if (hasServers) {
        tableBody.innerHTML = tableHtml;
        // Make sure it is ALWAYS visible if there are servers in the fleet at all
        container.style.display = 'block';
    } else {
        container.style.display = 'none';
    }
}

/**
 * ON-DEMAND DHCP IP DRILL-DOWN (NOC VIEW)
 */
async function openGlobalDhcpIps(serverId, scopeId, serverAlias) {
    const modal = document.getElementById('dhcp-modal');
    const title = document.getElementById('dhcp-modal-title');
    const sub = document.getElementById('dhcp-modal-sub');
    const container = document.getElementById('ip-list-container');
    
    if (!modal || !container) return;

    title.textContent = `Pool DHCP: ${serverAlias}`;
    sub.textContent = 'Conectando vía WinRM (On-Demand)...';
    container.innerHTML = `
        <div style="grid-column: 1/-1; text-align:center; padding:40px;">
            <div class="login-spinner" style="display:inline-block; width:30px; height:30px;"></div>
            <p style="margin-top:15px; font-size:0.8rem; color:var(--muted);">Consultando listado de IPs remoto...</p>
        </div>
    `;
    
    modal.classList.add('active');

    try {
        const res = await fetch(`/api/fleet/dhcp/ips?server_id=${serverId}&scope=${encodeURIComponent(scopeId)}`);
        const data = await res.json();

        if (!data.ok) {
            container.innerHTML = `<div style="grid-column: 1/-1; color:var(--danger); padding:20px; text-align:center;">
                <strong>Error de conexión:</strong><br>${data.error}
            </div>`;
            sub.textContent = 'Error en la consulta remota';
            return;
        }

        sub.textContent = `Rango detectado: ${data.total} IPs totales`;
        
        let ipHtml = '';
        data.ips.forEach(ip => {
            const color = ip.in_use ? 'var(--danger)' : 'var(--ok)';
            const label = ip.in_use ? 'OCUPADA' : 'LIBRE';
            ipHtml += `
                <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; display:flex; justify-content:space-between; align-items:center; border:1px solid rgba(255,255,255,0.03)">
                    <span style="font-family:'JetBrains Mono', monospace; font-size:0.85rem; color:var(--cream)">${ip.ip}</span>
                    <span style="font-size:0.6rem; font-weight:800; color:${color}; opacity:0.8;">${label}</span>
                </div>
            `;
        });

        if (data.truncated) {
            ipHtml += `<div style="grid-column: 1/-1; background:rgba(255,150,0,0.1); color:var(--warn); padding:10px; border-radius:6px; font-size:0.7rem; text-align:center;">
                ⚠️ Listado truncado a 1000 IPs por rendimiento.
            </div>`;
        }

        container.innerHTML = ipHtml;

    } catch (e) {
        container.innerHTML = `<div style="grid-column: 1/-1; color:var(--danger); padding:20px; text-align:center;">Error de red al intentar conectar con el servidor.</div>`;
    }
}

/**
 * FORZA EL REFRESCO DE DATOS DHCP EN LA FLOTA
 */
async function refreshGlobalDhcp() {
    const btn = document.querySelector('button[onclick="refreshGlobalDhcp()"]');
    if (btn) {
        btn.innerHTML = '<span class="login-spinner" style="width:12px; height:12px; display:inline-block; border-width:2px;"></span> REFRESCANDO...';
        btn.disabled = true;
    }

    try {
        const res = await fetch('/api/fleet/dhcp/refresh', { method: 'POST' });
        const data = await res.json();
        
        if (data.ok) {
            // Recargamos los datos del servidor (única fuente de verdad)
            await loadServerCards();
            if (btn) btn.innerHTML = '✅ REFRESCADO';
        } else {
            if (btn) btn.innerHTML = '❌ ERROR';
        }
    } catch (e) {
        if (btn) btn.innerHTML = '❌ ERROR RED';
    } finally {
        setTimeout(() => {
            if (btn) {
                btn.innerHTML = '🔄 REFRESCAR DHCP';
                btn.disabled = false;
            }
        }, 2000);
    }
}

