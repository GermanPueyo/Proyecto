from flask import render_template, request, jsonify, session, send_from_directory, current_app, Blueprint
import winrm
import os, secrets, threading, traceback, socket, ipaddress, warnings, logging, time

# Suppress PyWinRM CLIXML UserWarnings that pollute the terminal in Spanish Windows
warnings.filterwarnings("ignore", category=UserWarning, module="winrm")
logger = logging.getLogger(__name__)

from .database import get_all_servers, get_server, add_server, update_server, delete_server, _conn
import datetime

main_bp = Blueprint('main', __name__)
MASTER_AGENT_KEY = "flower-node-secret-2026" # Change this for production

@main_bp.after_request
def add_security_headers(response):
    """Reinforce browser-side security."""
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    return response

# ------------------------------------------------------------------
# Global caches and locks (Moved from app.py)
# ------------------------------------------------------------------
_sessions = {}
_sessions_lock = threading.Lock()
_metrics_cache = {}
_bg_threads = {}
_net_history = {} # sid -> {'rx': val, 'tx': val, 'time': float}

# NEW: Global Fleet Cache for NOC View
_fleet_metrics_cache = {} # server_id -> {cpu, disk, status, last_update}
_fleet_lock = threading.Lock()

def _get_ws(sid):
    with _sessions_lock:
        entry = _sessions.get(sid)
    if not entry:
        return None
    if entry.get("session") is None and entry.get("ip"):
        try:
            ws = winrm.Session(
                entry["ip"],
                auth=(entry["user"], entry["pwd"]),
                transport="ntlm",
                server_cert_validation="ignore"
            )
            entry["session"] = ws
        except:
            pass
    return entry

def _run_ps(ws, script):
    res = ws.run_ps(script)
    if res.status_code != 0:
        err = res.std_err.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(err or "PowerShell script returned non-zero")
    return res.std_out.decode("utf-8", errors="ignore").strip()

# ------------------------------------------------------------------
# Page Routes
# ------------------------------------------------------------------
@main_bp.route("/")
def index():
    return render_template("index.html")

@main_bp.route("/logo")
def logo():
    # Logo is now in static/img/
    img_dir = os.path.join(current_app.static_folder, "img")
    
    if os.path.isfile(os.path.join(img_dir, "tyler.svg")):
        return send_from_directory(img_dir, "tyler.svg", mimetype="image/svg+xml")
    
    fname = "logo.png" # Renamed during reorganization
    if os.path.isfile(os.path.join(img_dir, fname)):
        return send_from_directory(img_dir, fname)
        
    return "", 404

# ------------------------------------------------------------------
# API — CRUD
# ------------------------------------------------------------------
@main_bp.route("/api/servers")
def api_servers_list():
    from .database import get_all_servers, get_all_groups
    servers = get_all_servers()
    all_groups = get_all_groups()
    
    # Enrichment logic: 
    # 1. Start with DB data.
    # 2. Merge with _metrics_cache (streaming) - Highest priority.
    # 3. If no streaming, merge with _fleet_metrics_cache (background worker).
    
    # Pre-populate all groups in the result (to show empty ones)
    result_groups = {}
    for g in all_groups:
        result_groups[g['name']] = {
            "id": g['id'],
            "name": g['name'],
            "position": g['position'],
            "servers": []
        }

    with _sessions_lock:
        # Map server_id -> sid for active streams
        id_to_sid = { entry.get("server_id"): sid for sid, entry in _sessions.items() if entry.get("server_id") }
        
        for s in servers:
            s_data = dict(s)
            sid = id_to_sid.get(s["id"])
            
            # Case A: Live Streaming Session (User is currently in dashboard)
            if sid and sid in _metrics_cache:
                m = _metrics_cache[sid]
                s_data["metrics"] = {
                    "cpu": m.get("cpu", 0),
                    "ram": m.get("ram", 0),
                    "disk": m.get("disk", 0),
                    "status": "online",
                    "source": "streaming"
                }
            else:
                # Case B: Fleet Background Worker cache
                with _fleet_lock:
                    fm = _fleet_metrics_cache.get(s["id"])
                    if fm:
                        # Priority for agent status if available
                        s_status = fm.get("status", "offline")
                        # Handle Last Gasp / Shutdown
                        if s_status == "shutting_down":
                             s_status = "offline" 

                        s_data["metrics"] = {
                            "cpu": fm.get("cpu", 0),
                            "ram": fm.get("ram", 0),
                            "disk": fm.get("disk", 0),
                            "status": s_status,
                            "source": fm.get("source", "fleet_worker"),
                            "used_gb": fm.get("used_gb"),
                            "total_gb": fm.get("total_gb")
                        }
                    else:
                        s_data["metrics"] = {"status": "offline", "source": "none"}
            
            g_name = s.get("group_name") or "General"
            if g_name in result_groups:
                result_groups[g_name]["servers"].append(s_data)

    # Sort servers within groups by position
    for g in result_groups.values():
        g["servers"].sort(key=lambda x: (0 if x["metrics"]["status"] == "online" else 1, x["position"], x["alias"]))

    # Return groups as a sorted list
    sorted_groups = sorted(result_groups.values(), key=lambda x: (x["position"], x["name"]))
    return jsonify({"ok": True, "groups": sorted_groups})

# ------------------------------------------------------------------
# API — Group Management
# ------------------------------------------------------------------
@main_bp.route("/api/groups", methods=["GET", "POST"])
def api_groups():
    from .database import get_all_groups, add_group
    if request.method == "GET":
        return jsonify({"ok": True, "groups": get_all_groups()})
    
    data = request.json
    name = data.get("name")
    if not name: return jsonify({"ok": False, "error": "Name required"}), 400
    try:
        new_g = add_group(name)
        return jsonify({"ok": True, "group": new_g})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@main_bp.route("/api/groups/<int:gid>", methods=["PUT", "DELETE"])
def api_group_detail(gid):
    from .database import update_group, delete_group
    if request.method == "DELETE":
        delete_group(gid)
        return jsonify({"ok": True})
    
    data = request.json
    name = data.get("name")
    if not name: return jsonify({"ok": False, "error": "Name required"}), 400
    update_group(gid, name)
    return jsonify({"ok": True})

@main_bp.route("/api/groups/reorder", methods=["PATCH"])
def api_groups_reorder():
    from .database import _conn
    data = request.json
    order = data.get("order") # List of {id: X, position: Y}
    if not order: return jsonify({"ok": False}), 400
    
    with _conn() as c:
        for item in order:
            c.execute("UPDATE groups SET position=? WHERE id=?", (item['position'], item['id']))
        c.commit()
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# API — Server Interaction
# ------------------------------------------------------------------
@main_bp.route("/api/servers/move", methods=["PATCH"])
def api_server_move():
    from .database import move_server
    data = request.json
    sid = data.get("server_id")
    gid = data.get("group_id")
    pos = data.get("position", 0)
    if sid is None or gid is None:
        return jsonify({"ok": False, "error": "server_id and group_id required"}), 400
    
    move_server(sid, gid, pos)
    return jsonify({"ok": True})

@main_bp.route("/api/servers", methods=["POST"])
def api_servers_add():
    data = request.get_json(force=True)
    alias = (data.get("alias") or "").strip()
    ip    = (data.get("ip") or "").strip()
    user  = (data.get("user") or "").strip()
    pwd   = data.get("password", "")
    # Get group_id from request
    group_id = data.get("group_id")
    if group_id:
        try: group_id = int(group_id)
        except: group_id = None

    try:
        srv = add_server(
            alias=alias, ip=ip, username=user, password=pwd, 
            group_id=group_id, tags=data.get("tags", "")
        )
        return jsonify({"ok": True, "server": srv})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@main_bp.route("/api/servers/<int:sid>", methods=["PUT"])
def api_servers_edit(sid):
    data = request.get_json(force=True)
    alias = (data.get("alias") or "").strip()
    ip    = (data.get("ip") or "").strip()
    user  = (data.get("user") or "").strip()
    pwd   = data.get("password", "") or None
    group = (data.get("client_group") or "General").strip()

    if not alias or not ip or not user:
        return jsonify({"ok": False, "error": "Alias, IP y usuario son obligatorios"}), 400
    
    # Duplicate check (excluding self)
    all_srv = get_all_servers()
    if any(s["alias"].lower() == alias.lower() and s["id"] != sid for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe otro servidor con ese nombre (Alias)"}), 400
    if any(s["ip"] == ip and s["id"] != sid for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe otro servidor con esa dirección IP"}), 400

    update_data = {
        "alias": alias, "ip": ip, "username": user, 
        "group_id": int(data.get("group_id")) if data.get("group_id") else None,
        "tags": data.get("tags", "")
    }
    if pwd: update_data["password"] = pwd

    ok = update_server(sid, **update_data)
    return jsonify({"ok": ok})

@main_bp.route("/api/servers/<int:sid>", methods=["DELETE"])
def api_servers_delete(sid):
    ok = delete_server(sid)
    return jsonify({"ok": ok})

@main_bp.route("/api/servers/<int:sid>/status")
def api_servers_status(sid):
    srv = get_server(sid)
    if not srv:
        return jsonify({"ok": False, "error": "No existe"})
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.5)
            is_up = (s.connect_ex((srv["ip"], 5985)) == 0)
    except:
        is_up = False
    return jsonify({"ok": True, "status": "online" if is_up else "offline"})

# ------------------------------------------------------------------
# API — Connection & Metrics
# ------------------------------------------------------------------
@main_bp.route("/api/connect", methods=["POST"])
def api_connect():
    data = request.get_json(force=True)
    server_id = data.get("server_id")

    if server_id:
        srv = get_server(int(server_id))
        if not srv:
            return jsonify({"ok": False, "error": "Servidor no encontrado en la BD"}), 404
        ip   = srv["ip"]
        user = srv["username"]
        pwd  = srv["password"]
    else:
        ip   = (data.get("ip") or "").strip()
        user = (data.get("user") or "").strip()
        pwd  = data.get("password", "")

    if (not ip or not user or not pwd):
        return (jsonify({'ok': False, 'error': 'Todos los campos son obligatorios'}), 400)
    
    # 1. FAST PRE-FLIGHT PROBE (2s Timeout)
    # If the server is offline, we fail fast before engaging the heavy WinRM engine.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            if s.connect_ex((ip.split(':')[0], 5985)) != 0:
                return (jsonify({'ok': False, 'error': 'Servidor inalcanzable (Puerto 5985 cerrado o IP apagada)'}), 401)
    except Exception as e:
        return (jsonify({'ok': False, 'error': f'Error de red: {str(e)}'}), 401)

    try:
        # EXPLICIT PORT 5985 FORCED
        ws_url = f"http://{ip.split(':')[0]}:5985/wsman"
        ws = winrm.Session(
            ws_url, auth=(user, pwd),
            transport="ntlm",
            server_cert_validation="ignore",
            read_timeout_sec=30,
            operation_timeout_sec=25
        )
        
        # MASTER RESET: Cleanup any previous sessions for this same IP before starting a new one
        with _sessions_lock:
            stale_sids = [s for s, e in _sessions.items() if e.get("ip") == ip]
            for s in stale_sids:
                _sessions.pop(s, None)
                _metrics_cache.pop(s, None)
                _net_history.pop(s, None)
                logger.info(f"Cleaned up stale session {s} for IP {ip}")
        # BALANCED SPECS SCRIPT: Complete yet stable
        script = r'''
        $p = Get-CimInstance Win32_Processor;
        $os = Get-CimInstance Win32_OperatingSystem;
        $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";
        $cs = Get-CimInstance Win32_ComputerSystem;
        $net = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" | Select-Object Description, @{N='IP';E={$_.IPAddress[0]}}, MACAddress, @{N='GW';E={$_.DefaultIPGateway[0]}}, @{N='DNS';E={$_.DNSServerSearchOrder[0]}}
        $netJson = if($net){ $net | ConvertTo-Json -Compress } else { "[]" }
        if($net -and $net.Count -eq $null){ $netJson = "[$netJson]" } # Ensure array

        "$($p[0].Name)|$($p[0].NumberOfCores)|$($p[0].NumberOfLogicalProcessors)|$($p[0].MaxClockSpeed)|$($os.TotalVisibleMemorySize)|$($d.Size)|$($cs.Name)|$($cs.Domain)|$($cs.Manufacturer)|$($os.Caption)|$($os.LastBootUpTime.ToString('yyyyMMddHHmmss'))|$netJson"
        '''
        raw = _run_ps(ws, script)
        try:
            p = raw.split("|")
            import json
            try: net_adapters = json.loads(p[11])
            except: net_adapters = []
            
            specs = {
                "ok": True, 
                "cpu_name": p[0], "cpu_cores": p[1], "cpu_logical": p[2], "cpu_speed": p[3],
                "ram_total_kb": p[4], "disk_total_b": p[5], 
                "hostname": p[6], "domain": p[7], "manufacturer": p[8],
                "os_version": p[9], "raw_uptime": p[10], "net_adapters": net_adapters
            }
        except Exception as e:
            raise ValueError(f"Specs Error: {str(e)}")

        sid = secrets.token_hex(16)
        with _sessions_lock:
            _sessions[sid] = {
                "session": ws, 
                "specs": specs, 
                "ip": ip, 
                "user": user, 
                "pwd": pwd,
                "server_id": int(server_id) if server_id else None
            }

        t = threading.Thread(target=_bg_poller, args=(sid,), daemon=True)
        _bg_threads[sid] = t
        t.start()
        session["sid"] = sid
        session["last_ip"] = ip
        return jsonify({"ok": True, "sid": sid, "specs": specs})

    except Exception as exc:
        current_app.logger.error(f"CONNECT ERROR: {traceback.format_exc()}")
        err_str = str(exc).lower()
        msg = "Error de comunicación con el servidor remoto."
        
        if "401" in err_str or "unauthorized" in err_str or "auth" in err_str:
            msg = "Credenciales incorrectas o acceso denegado."
        elif "timeout" in err_str:
            msg = "Tiempo de espera agotado. El servidor está saturado o es lento."
        elif "unreachable" in err_str or "connecting" in err_str:
            msg = "Servidor inalcanzable. Verifica la IP y el puerto 5985."
        elif "500" in err_str or "bad http response" in err_str:
            msg = "El servidor remoto respondió con un error (WinRM saturado)."
            
        return jsonify({"ok": False, "error": msg}), 401

@main_bp.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    payload_sid = (request.get_json(force=True) or {}).get("sid")
    flask_sid = session.get("sid")
    
    if payload_sid and flask_sid == payload_sid:
        session.pop("sid", None)
    
    sid_to_remove = payload_sid or flask_sid
    if sid_to_remove:
        with _sessions_lock:
            _sessions.pop(sid_to_remove, None)
            _metrics_cache.pop(sid_to_remove, None)
            _net_history.pop(sid_to_remove, None)
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# ACTIVE AGENT RECEPTOR
# ------------------------------------------------------------------
@main_bp.route("/api/agent/report", methods=["POST"])
def agent_report():
    data = request.json
    api_key = request.headers.get("X-API-KEY")
    client_ip = request.remote_addr

    if not data or api_key != MASTER_AGENT_KEY:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    
    srv_id = data.get("server_id")
    if not srv_id: return jsonify({"ok": False}), 400

    # Validate IP matches DB
    srv = get_server(srv_id)
    if not srv or srv["ip"] != client_ip:
        logger.warning(f"Agent IP mismatch or invalid ID: {client_ip} for ID {srv_id}")
        return jsonify({"ok": False, "error": "Identity mismatch"}), 403

    status = data.get("status", "online")
    metrics = {
        "cpu": data.get("cpu", 0),
        "ram": data.get("ram", 0),
        "disk": data.get("disk", 0),
        "status": status,
        "source": "agent",
        "last_sync": time.time()
    }

    # Update Global Cache
    with _fleet_lock:
        _fleet_metrics_cache[srv_id] = metrics

    # Sync to DB
    update_server(srv_id, status=status, last_seen=datetime.datetime.now(), is_agent=1)
    
    return jsonify({"ok": True})

@main_bp.route("/api/metrics")
def api_metrics():
    """
    ULTRA-FAST CACHE-FIRST API: Multi-Server Isolated.
    """
    sid = request.args.get("sid") or session.get("sid")
    client_srv_id = request.args.get("server_id") # Explicitly passed by frontend
    
    # Priority 1: High-Speed Detail Streaming Cache (Matched by SID)
    data = _metrics_cache.get(sid)
    if data:
        entry = _get_ws(sid)
        return jsonify({"ok": True, "source": "streaming", "specs": entry.get("specs") if entry else None, **data})

    # Priority 2: Fleet Worker Cache Fallback (Using explicit server_id for reliability)
    target_id = None
    if client_srv_id:
        try: target_id = int(client_srv_id)
        except: pass
    else:
        entry = _get_ws(sid)
        if entry: target_id = entry.get("server_id")

    if target_id:
        with _fleet_lock:
            fm = _fleet_metrics_cache.get(target_id)
            if fm and fm.get("status") == "online":
                return jsonify({
                    "ok": True,
                    "source": "fleet",
                    "specs": None,
                    "cpu": fm.get("cpu", 0),
                    "ram": fm.get("ram", 0),
                    "disk": fm.get("disk", 0),
                    "status": "online"
                })

    # Priority 3: Loading / No Context
    return jsonify({
        "ok": True, "status": "loading", 
        "cpu": 0, "ram": 0, "disk": 0,
        "recv_mbps": 0, "sent_mbps": 0, "processes": 0, "threads": 0
    })

@main_bp.route("/api/disks")
def api_disks():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"): return jsonify({"ok": False, "error": "No conectado"}), 401
    script = r'''
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue';
try {
    $disks = @()
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -EA Stop | ForEach-Object {
        $ld = $_
        $media = "Desconocido"
        $health = "No disponible"
        $driveLetter = $ld.DeviceID
        try {
            $part = Get-Partition -DriveLetter $driveLetter[0] -ErrorAction SilentlyContinue
            if ($part) {
                $phys = Get-PhysicalDisk -ObjectId $part.DiskId -ErrorAction SilentlyContinue
                if ($phys) {
                    $media = $phys.MediaType
                    $health = $phys.HealthStatus
                }
            }
        } catch {}
        $total = [math]::Round($ld.Size / 1GB, 2)
        $free  = [math]::Round($ld.FreeSpace / 1GB, 2)
        $used  = $total - $free
        $pct   = if($total -gt 0) { [math]::Round(($used / $total) * 100, 2) } else { 0 }
        
        $disks += @{
            letter = $driveLetter
            total_gb = $total
            free_gb = $free
            used_gb = $used
            used_pct = $pct
            filesystem = $ld.FileSystem
            label = if($ld.VolumeName){$ld.VolumeName}else{"Sin etiqueta"}
            media_type = $media
            health = $health
        }
    }
    $res = @{ ok=$true; disks=$disks }
    Write-Output ($res | ConvertTo-Json -Depth 5 -Compress)
} catch {
    $err = $_.Exception.Message.Replace('"', '\"').Replace("`n", " ")
    Write-Output "{\`"ok\`":false,\`"error\`":\`"Excepcion de PS: $err\`"}"
}
'''
    try:
        import json
        ws_temp = winrm.Session(
            entry["ip"], auth=(entry["user"], entry["pwd"]),
            transport="ntlm", server_cert_validation="ignore",
            read_timeout_sec=30, operation_timeout_sec=25
        )
        raw = _run_ps(ws_temp, script)
        data = json.loads(raw)
        if not data.get("ok"): return jsonify(data), 500
        return jsonify({"ok": True, "disks": data.get("disks", [])})
    except Exception as e: 
        return jsonify({"ok": False, "error": str(e)}), 500

@main_bp.route("/api/dhcp")
def api_dhcp():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"): return jsonify({"ok": False, "error": "No conectado"}), 401
    script = r'''
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue';
try {
    $svc = try { Get-Service dhcpserver -EA Stop } catch { $null }
    if (-not $svc) {
        Write-Output '{"ok":true, "dhcp_installed":false}'
    } else {
        $scopes = try { Get-DhcpServerv4Scope -EA Stop } catch { $null }
        if (-not $scopes) {
            Write-Output '{"ok":true, "dhcp_installed":true, "scopes":[]}'
        } else {
            $statsAll = Get-DhcpServerv4ScopeStatistics
            $outScopes = @()
            foreach ($s in $scopes) {
                $stats = $statsAll | Where-Object ScopeId -eq $s.ScopeId
                $pct = if ($stats.PercentageInUse) { $stats.PercentageInUse } else { 0 }
                $outScopes += @{
                    scope_id = "$($s.ScopeId)"
                    name = "$($s.Name)"
                    start_range = "$($s.StartRange)"
                    end_range = "$($s.EndRange)"
                    subnet_mask = "$($s.SubnetMask)"
                    free = $stats.Free
                    in_use = $stats.InUse
                    pct_in_use = $pct
                }
            }
            $res = @{ ok=$true; dhcp_installed=$true; scopes=$outScopes }
            Write-Output ($res | ConvertTo-Json -Depth 5 -Compress)
        }
    }
} catch {
    $err = $_.Exception.Message.Replace('"', '\"').Replace("`n", " ")
    Write-Output "{\`"ok\`":false,\`"error\`":\`"Excepcion de PS: $err\`"}"
}
'''
    try:
        import json
        ws_temp = winrm.Session(
            entry["ip"], auth=(entry["user"], entry["pwd"]),
            transport="ntlm", server_cert_validation="ignore",
            read_timeout_sec=30, operation_timeout_sec=25
        )
        raw = _run_ps(ws_temp, script)
        data = json.loads(raw)
        if not data.get("ok"): return jsonify(data), 500
        return jsonify(data)
    except Exception as e: 
        return jsonify({"ok": False, "error": str(e)}), 500

@main_bp.route("/api/dhcp/ips")
def api_dhcp_ips():
    import ipaddress, json
    sid = request.args.get("sid") or session.get("sid"); scope_id = request.args.get("scope")
    entry = _get_ws(sid)
    if not entry or not entry.get("session") or not scope_id: return jsonify({"ok": False, "error": "Invalid"}), 401
    
    script = f'''
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue';
try {{
    $scope = Get-DhcpServerv4Scope -ScopeId "{scope_id}" -EA Stop
    $leases = @()
    try {{
        $leasesData = Get-DhcpServerv4Lease -ScopeId "{scope_id}" -EA Stop
        foreach ($l in $leasesData) {{ $leases += "$($l.IPAddress)" }}
    }} catch {{}}
    
    $res = @{{
        ok = $true
        start = "$($scope.StartRange)"
        end = "$($scope.EndRange)"
        leases = $leases
    }}
    Write-Output ($res | ConvertTo-Json -Depth 4 -Compress)
}} catch {{
    $err = $_.Exception.Message.Replace('"', '\\"').Replace("`n", " ")
    Write-Output "{{\\`"ok\\`":false,\\`"error\\`":\\`"Excepcion de PS: $err\\`"}}"
}}
'''
    try:
        ws_temp = winrm.Session(
            entry["ip"], auth=(entry["user"], entry["pwd"]),
            transport="ntlm", server_cert_validation="ignore",
            read_timeout_sec=30, operation_timeout_sec=25
        )
        raw = _run_ps(ws_temp, script)
        data = json.loads(raw)
        if not data.get("ok"): return jsonify(data), 500
        
        start_ip = data.get("start")
        end_ip = data.get("end")
        raw_leases = data.get("leases")
        if isinstance(raw_leases, str): raw_leases = [raw_leases]
        if not raw_leases: raw_leases = []
        leases = set(raw_leases)
        
        try:
            start_val = int(ipaddress.IPv4Address(start_ip))
            end_val = int(ipaddress.IPv4Address(end_ip))
        except:
            return jsonify({"ok": False, "error": "Rango de IPs inválido devuelto por PowerShell"}), 500
            
        total_ips = end_val - start_val + 1
        limit = 1000
        is_truncated = False
        
        if total_ips > limit:
            end_val = start_val + limit - 1
            is_truncated = True
            
        ips = []
        for ip_int in range(start_val, end_val + 1):
            ip_str = str(ipaddress.IPv4Address(ip_int))
            ips.append({
                "ip": ip_str,
                "in_use": ip_str in leases
            })
            
        return jsonify({
            "ok": True, 
            "ips": ips, 
            "total": total_ips, 
            "truncated": is_truncated
        })
    except Exception as e: 
        return jsonify({"ok": False, "error": str(e)}), 500

# ------------------------------------------------------------------
# Background Poller  — Streaming Mode (Ultra-Low Latency)
# ------------------------------------------------------------------
def _safe_float(val, default=0.0):
    """Parses a float string correctly even if it uses a comma as a decimal separator."""
    try:
        s = str(val).strip().replace(',', '.')
        if not s or s == "0": return default
        return float(s)
    except:
        return default

def _safe_int(val, default=0):
    """Parses an integer safely, handling floats or empty strings."""
    try:
        s = str(val).strip()
        if not s: return default
        return int(float(s.replace(',', '.')))
    except:
        return default

def _bg_poller(sid):
    """
    ULTRA-ROBUST Background poller with Delta (differential) calculations.
    """
    import json, time, traceback
    prev_data = {} # To store raw values for delta calc

    while True:
        try:
            # Check if session still exists
            with _sessions_lock:
                entry = _sessions.get(sid)
                if not entry:
                    logger.info(f"Session {sid} closed. Poller exiting.")
                    break
                ws = entry.get("session")
                specs = entry.get("specs", {})
                ip = entry.get("ip")

            if not ws:
                # Restore session with explicit port
                with _sessions_lock:
                    entry = _sessions.get(sid)
                    if entry and entry.get("ip"):
                        try:
                            ws_url = f"http://{entry['ip'].split(':')[0]}:5985/wsman"
                            ws = winrm.Session(
                                ws_url, auth=(entry["user"], entry["pwd"]),
                                transport="ntlm", server_cert_validation="ignore",
                                read_timeout_sec=30, operation_timeout_sec=25
                            )
                            entry["session"] = ws
                            logger.info(f"Session restored for SID {sid}")
                        except: pass
                if not ws:
                    time.sleep(2); continue

            # INSTANT MONITOR (No averaging for realistic spikes)
            ps = r'''
            $ErrorActionPreference='SilentlyContinue';
            $c = (Get-CimInstance Win32_Processor).LoadPercentage[0];
            $m = Get-CimInstance Win32_OperatingSystem;
            $d = Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter "Name='_Total'";
            $s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System;
            $ni = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface;
            $net = if($ni){($ni | Measure-Object BytesTotalPersec -Sum).Sum}else{0};
            
            "$($c)|$($m.FreePhysicalMemory)|$($m.NumberOfProcesses)|$($s.Threads)|$($d.PercentDiskTime)|$($d.DiskReadBytesPersec)|$($d.DiskWriteBytesPersec)|$($net)"
            '''
            
            try:
                res = ws.run_ps(ps)
            except Exception as e:
                # If we get a 400 Bad Request or similar transport error, the session is corrupted.
                # Force a reset so the block above attempts a reconnect.
                if "400" in str(e) or "bad http response" in str(e).lower():
                    logger.warning(f"Session corrupted for {sid}, resetting: {e}")
                    with _sessions_lock:
                        if sid in _sessions:
                            _sessions[sid]["session"] = None # Force reconnect next loop
                raise # Let the outer try-except log it and sleep
            
            if res.status_code == 0:
                raw = res.std_out.decode('utf-8', errors='ignore').strip()
                parts = raw.split('|')
                if len(parts) >= 8:
                    now = time.time()
                    dt = now - prev_data.get('ts', now - 1)
                    if dt <= 0: dt = 1.0
                    
                    cpu = _safe_int(parts[0])
                    free_kb = _safe_float(parts[1])
                    procs = _safe_int(parts[2])
                    threads = _safe_int(parts[3])
                    
                    # DISK DELTA
                    raw_disk_ticks = _safe_float(parts[4])
                    raw_read = _safe_float(parts[5])
                    raw_write = _safe_float(parts[6])
                    
                    disk_pct = 0
                    d_read = 0
                    d_write = 0
                    
                    if 'disk' in prev_data:
                        # Raw ticks to % approx (simplified delta)
                        d_ticks = max(0, raw_disk_ticks - prev_data['disk'])
                        disk_pct = min(100, (d_ticks / (dt * 1e7)) * 100) if raw_disk_ticks > 0 else 0
                        d_read = round(max(0, raw_read - prev_data['read']) / (dt * 1e6), 2)
                        d_write = round(max(0, raw_write - prev_data['write']) / (dt * 1e6), 2)
                    
                    prev_data.update({'disk': raw_disk_ticks, 'read': raw_read, 'write': raw_write, 'ts': now})
                    
                    net_bytes = _safe_float(parts[7])
                    mbps = 0
                    if 'net' in prev_data:
                        mbps = max(0, (net_bytes - prev_data['net']) * 8) / (dt * 1e6)
                    prev_data['net'] = net_bytes
                    
                    # RAM
                    total_kb = float(specs.get("ram_total_kb") or 1)
                    ram_pct = round(((total_kb - free_kb) / total_kb) * 100, 1) if total_kb > 0 else 0

                    # Success: Update cache with Rounded values
                    _metrics_cache[sid] = {
                        "cpu": max(0, min(100, cpu)),
                        "ram": max(0, min(100, ram_pct)),
                        "disk": round(max(0, min(100, disk_pct)), 1),
                        "recv_mbps": round(mbps * 0.7, 2),
                        "sent_mbps": round(mbps * 0.3, 2),
                        "processes": procs,
                        "threads": threads,
                        "disk_read": d_read,
                        "disk_write": d_write
                    }
                    with open("poller_debug.txt", "a") as f:
                        f.write(f"SUCCESS SID {sid} parts {parts}\n")
                else:
                    with open("poller_debug.txt", "a") as f:
                        f.write(f"PARTS TOO SHORT: {raw}\n")
            else:
                logger.warning(f"WinRM Poll failed for {ip} (SID {sid}): {res.std_err.decode('utf-8', errors='ignore')}")
                with open("poller_debug.txt", "a") as f:
                    f.write(f"STATUS CODE FAIL: {res.status_code}\n")

        except Exception as e:
            logger.error(f"POLLER CRITICAL ERROR for {sid}: {traceback.format_exc()}")
            with open("poller_debug.txt", "a") as f:
                f.write(f"CRITICAL: {traceback.format_exc()}\n")
        
        time.sleep(0.7) # Synchronized with frontend (0.9s)

# ------------------------------------------------------------------
# GLOBAL FLEET WORKER (Fleet NOC metrics)
# ------------------------------------------------------------------
_fleet_sessions = {} # server_id -> Session object (persistent)

def _fleet_worker_loop():
    """Enterprise-grade concurrent worker for high-scale monitoring (40+ servers)."""
    from .database import decrypt_password, _conn
    from concurrent.futures import ThreadPoolExecutor
    import time

    logger.info("🚀 GLOBAL FLEET WORKER: CONCURRENCY MODE ACTIVE")
    
    while True:
        try:
            # 1. Fetch current server list
            servers = []
            with _conn() as c:
                rows = c.execute("SELECT id, ip, username, password_enc FROM servers").fetchall()
                servers = [dict(r) for r in rows]
            
            if not servers:
                time.sleep(10); continue

            # 2. Define the individual worker task
            def poll_one(s):
                srv_id = s["id"]
                ip = s["ip"]
                is_agent = s.get("is_agent", 0)
                
                # HEARTBEAT CHECK for AGENTS
                if is_agent:
                    with _fleet_lock:
                        fm = _fleet_metrics_cache.get(srv_id)
                        if fm and time.time() - fm.get("last_sync", 0) > 120:
                             return srv_id, {"status": "offline", "source": "agent"}
                        return srv_id, fm if fm else {"status": "offline", "source": "agent"}

                # PRE-FLIGHT: Fast socket check (1s timeout)
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                        sock.settimeout(1.0)
                        if sock.connect_ex((ip, 5985)) != 0:
                            return srv_id, {"status": "offline"}
                except:
                    return srv_id, {"status": "offline"}

                try:
                    # SESSION REUSE: Avoid handshake overhead
                    if srv_id not in _fleet_sessions:
                        pwd = decrypt_password(s["password_enc"])
                        _fleet_sessions[srv_id] = winrm.Session(
                            ip, auth=(s["username"], pwd), 
                            transport="ntlm", server_cert_validation="ignore",
                            read_timeout_sec=10, operation_timeout_sec=8
                        )
                    
                    ws = _fleet_sessions[srv_id]
                    # Optimized NOC query: Instant CPU + RAM + Disk Space
                    ps = r'''
                    $ErrorActionPreference='Stop';
                    $c = (Get-CimInstance Win32_Processor).LoadPercentage[0]; 
                    $os = Get-CimInstance Win32_OperatingSystem;
                    $ramPct = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 0);
                    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";
                    $total = [math]::Round($d.Size / 1GB, 0);
                    $free = [math]::Round($d.FreeSpace / 1GB, 0);
                    $used = $total - $free;
                    $diskPct = if($total -gt 0){ [math]::Round(($used/$total)*100,0) }else{0};
                    "$c;$ramPct;$diskPct;$used;$total"
                    '''
                    res = ws.run_ps(ps)
                    if res.status_code == 0:
                        raw = res.std_out.decode('utf-8', errors='ignore').strip()
                        parts = raw.split(';')
                        if len(parts) >= 4:
                            return srv_id, {
                                "status": "online",
                                "cpu": int(parts[0]),
                                "ram": int(parts[1]),
                                "disk": int(parts[2]),
                                "used_gb": int(parts[3]),
                                "total_gb": int(parts[4]),
                                "last_sync": time.time()
                            }
                except Exception as e:
                    _fleet_sessions.pop(srv_id, None) # Clear corrupted session
                
                return srv_id, {"status": "online"} # Placeholder if PS failed but connection is up

            # 3. Parallel Execution with controlled max_workers
            with ThreadPoolExecutor(max_workers=20) as executor:
                results = list(executor.map(poll_one, servers))
            
            # 4. Atomic Cache Update (Thread-Safe)
            with _fleet_lock:
                for srv_id, metrics in results:
                    _fleet_metrics_cache[srv_id] = metrics
                    
        except Exception as ge:
            logger.error(f"FATAL FLEET WORKER ERROR: {ge}")
            
        # 5. ENTERPRISE REST INTERVAL (12s) - Optimized for responsiveness
        time.sleep(12) 

# Start the thread on module import
threading.Thread(target=_fleet_worker_loop, daemon=True).start()
