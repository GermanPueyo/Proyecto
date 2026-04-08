from flask import render_template, request, jsonify, session, send_from_directory, current_app, Blueprint
import winrm
import os, secrets, threading, traceback, socket, ipaddress
from .database import get_all_servers, get_server, add_server, update_server, delete_server

main_bp = Blueprint('main', __name__)

# ------------------------------------------------------------------
# Global caches and locks (Moved from app.py)
# ------------------------------------------------------------------
_sessions = {}
_sessions_lock = threading.Lock()
_winrm_locks = {}
_metrics_cache = {}
_bg_threads = {}

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
    return jsonify({"ok": True, "servers": get_all_servers()})

@main_bp.route("/api/servers", methods=["POST"])
def api_servers_add():
    data = request.get_json(force=True)
    alias = (data.get("alias") or "").strip()
    ip    = (data.get("ip") or "").strip()
    user  = (data.get("user") or "").strip()
    pwd   = data.get("password", "")
    if not alias or not ip or not user or not pwd:
        return jsonify({"ok": False, "error": "Todos los campos son obligatorios"}), 400
    try:
        srv = add_server(alias, ip, user, pwd)
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
    if not alias or not ip or not user:
        return jsonify({"ok": False, "error": "Alias, IP y usuario son obligatorios"}), 400
    ok = update_server(sid, alias, ip, user, pwd)
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

    if not ip or not user or not pwd:
        return jsonify({"ok": False, "error": "Todos los campos son obligatorios"}), 400

    try:
        ws = winrm.Session(
            ip, auth=(user, pwd),
            transport="ntlm",
            server_cert_validation="ignore"
        )
        # Powerhell Script (Truncated for brevity in this scratch file, but full in real code)
        script = r'''
$c  = Get-CimInstance Win32_Processor
$os = Get-CimInstance Win32_OperatingSystem
$d  = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$cs = Get-CimInstance Win32_ComputerSystem
$net = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True"
$uptime = (Get-Date) - $os.LastBootUpTime
$uptimeStr = "$($uptime.Days) d, $($uptime.Hours) h, $($uptime.Minutes) m"
$role = if ($cs.PartOfDomain) { "Dominio" } else { "Grupo de Trabajo" }
$l2 = ($c | Measure-Object L2CacheSize -Sum).Sum
$l3 = ($c | Measure-Object L3CacheSize -Sum).Sum
$netJson = @()
foreach ($n in $net) {
    $ipv4s = $n.IPAddress | Where-Object { $_ -match "\." }
    $ip = if($ipv4s){$ipv4s -join ", "}else{"-"}
    $gws = $n.DefaultIPGateway | Where-Object { $_ -match "\." }
    $gw = if($gws){$gws -join ", "}else{"-"}
    $dnss = $n.DNSServerSearchOrder | Where-Object { $_ -match "\." }
    $dns = if($dnss){$dnss -join ", "}else{"-"}
    $mac = if($n.MACAddress){$n.MACAddress}else{"-"}
    $desc = if($n.Description){$n.Description}else{"Adaptador Desconocido"}
    $netJson += "$desc~~$ip~~$mac~~$gw~~$dns"
}
$netJoined = $netJson -join "^^"
$mem = Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue
$speed = if ($mem) { ($mem | Select-Object -First 1).Speed } else { 0 }
$manufacturer = if ($cs.Manufacturer) { $cs.Manufacturer } else { "Desconocido" }
$rolesList = ""
Write-Output ("$($c[0].Name)|$($c[0].NumberOfCores)|$($c[0].NumberOfLogicalProcessors)|$($c[0].MaxClockSpeed)|$($os.TotalVisibleMemorySize)|$($d.Size)|$l2|$l3|$($c[0].VirtualizationFirmwareEnabled)|$($os.Caption) $($os.Version)|$uptimeStr|$($cs.Name)|$role|$($cs.Domain)|$netJoined|$speed|$manufacturer|$rolesList")
'''
        raw = _run_ps(ws, script)
        p = raw.split("|")
        if len(p) < 17: raise ValueError("Respuesta incompleta")

        net_raw = p[14] if len(p) > 14 else ""
        net_adapters = []
        if net_raw:
            for n in net_raw.split("^^"):
                parts = n.split("~~")
                if len(parts) == 5:
                    net_adapters.append({"desc": parts[0], "ip": parts[1], "mac": parts[2], "gw": parts[3], "dns": parts[4]})

        specs = {
            "cpu_name": p[0], "cpu_cores": p[1], "cpu_logical": p[2], "cpu_speed": p[3],
            "ram_total_kb": p[4], "disk_total_b": p[5], "cpu_l2_kb": p[6], "cpu_l3_kb": p[7],
            "cpu_virt": p[8], "os_version": p[9], "uptime": p[10], "hostname": p[11],
            "domain_role": p[12], "domain": p[13], "net_adapters": net_adapters,
            "ram_speed": p[15], "manufacturer": p[16], "server_roles": p[17] if len(p) > 17 else ""
        }

        sid = secrets.token_hex(16)
        with _sessions_lock:
            _sessions[sid] = {"session": ws, "specs": specs, "ip": ip, "user": user, "pwd": pwd}
            _winrm_locks[sid] = threading.Lock()

        t = threading.Thread(target=_bg_poller, args=(sid,), daemon=True)
        _bg_threads[sid] = t
        t.start()
        session["sid"] = sid
        return jsonify({"ok": True, "sid": sid, "specs": specs})

    except Exception as exc:
        current_app.logger.error(f"CONNECT ERROR: {traceback.format_exc()}")
        err_str = str(exc)
        msg = "Error desconocido"
        if "401" in err_str or "auth" in err_str.lower(): msg = "Credenciales incorrectas."
        elif "Timeout" in err_str or "unreachable" in err_str: msg = "Servidor inalcanzable."
        return jsonify({"ok": False, "error": msg}), 401

@main_bp.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    sid = session.pop("sid", None) or (request.get_json(force=True) or {}).get("sid")
    if sid:
        with _sessions_lock:
            _sessions.pop(sid, None)
            _winrm_locks.pop(sid, None)
            _metrics_cache.pop(sid, None)
    return jsonify({"ok": True})

@main_bp.route("/api/metrics")
def api_metrics():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"): return jsonify({"ok": False, "error": "No conectado"}), 401
    data = _metrics_cache.get(sid)
    if not data: data = {"cpu":0,"ram":0,"ram_used_gb":0,"ram_free_gb":0,"disk":0,"recv_mbps":0,"sent_mbps":0,"processes":0,"threads":0,"handles":0,"disk_read":0,"disk_write":0}
    return jsonify({"ok": True, **data})

@main_bp.route("/api/disks")
def api_disks():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"): return jsonify({"ok": False, "error": "No conectado"}), 401
    script = r'''
$phys = Get-PhysicalDisk -ErrorAction SilentlyContinue
Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    $total=[math]::Round($_.Size/1GB, 2); $free=[math]::Round($_.FreeSpace/1GB, 2); $pct=if($_.Size -gt 0){[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100, 1)}else{0};
    Write-Output "$($_.DeviceID)|$total|$free|$([math]::Round(($_.Size-$_.FreeSpace)/1GB, 2))|$pct|$($_.FileSystem)|$($_.VolumeName)"
}'''
    lock = _winrm_locks.get(sid)
    with lock:
        try:
            raw = _run_ps(entry["session"], script)
            disks = []
            for line in raw.strip().splitlines():
                cols = line.replace(",", ".").split("|")
                if len(cols) >= 6:
                    disks.append({"letter":cols[0],"total_gb":float(cols[1]),"free_gb":float(cols[2]),"used_gb":float(cols[3]),"used_pct":float(cols[4]),"filesystem":cols[5],"label":cols[6] if len(cols)>6 else "Sin etiqueta"})
            return jsonify({"ok": True, "disks": disks})
        except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500

@main_bp.route("/api/dhcp")
def api_dhcp():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"): return jsonify({"ok": False, "error": "No conectado"}), 401
    script = r'''
$svc = Get-Service dhcpserver -ErrorAction SilentlyContinue
if (-not $svc) { Write-Output "NO_DHCP_ROLE" } else {
    $scopes = Get-DhcpServerv4Scope -ErrorAction SilentlyContinue
    if (-not $scopes) { Write-Output "NO_SCOPES" } else {
        $statsAll = Get-DhcpServerv4ScopeStatistics
        foreach ($s in $scopes) {
            $stats = $statsAll | Where-Object ScopeId -eq $s.ScopeId
            Write-Output "$($s.ScopeId)|$($s.Name)|$($s.StartRange)|$($s.EndRange)|$($s.SubnetMask)|$($stats.Free)|$($stats.InUse)|$($stats.PercentageInUse)"
        }
    }
}'''
    lock = _winrm_locks.get(sid)
    with lock:
        try:
            raw = _run_ps(entry["session"], script).strip()
            if "NO_DHCP_ROLE" in raw: return jsonify({"ok": True, "dhcp_installed": False})
            if "NO_SCOPES" in raw: return jsonify({"ok": True, "dhcp_installed": True, "scopes": []})
            scopes = []
            for line in raw.splitlines():
                cols = line.split("|")
                if len(cols)>=8:
                    scopes.append({"scope_id":cols[0],"name":cols[1],"start_range":cols[2],"end_range":cols[3],"subnet_mask":cols[4],"free":int(cols[5]),"in_use":int(cols[6]),"pct_in_use":float(cols[7].replace(",","."))})
            return jsonify({"ok": True, "dhcp_installed": True, "scopes": scopes})
        except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500

@main_bp.route("/api/dhcp/ips")
def api_dhcp_ips():
    sid = request.args.get("sid") or session.get("sid"); scope_id = request.args.get("scope")
    entry = _get_ws(sid)
    if not entry or not entry.get("session") or not scope_id: return jsonify({"ok": False, "error": "Invalid"}), 401
    script = f'Get-DhcpServerv4Scope -ScopeId "{scope_id}"; Get-DhcpServerv4Lease -ScopeId "{scope_id}"'
    # For now returning dummy/simplified due to complexity of range generation here
    return jsonify({"ok": True, "ips": []})

# ------------------------------------------------------------------
# Background Poller
# ------------------------------------------------------------------
def _bg_poller(sid):
    import time
    script = r'''
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
if($null -eq $cpu){$cpu=0}
$os  = Get-CimInstance Win32_OperatingSystem
$pd  = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
$sys = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
$n = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object -First 1
$rx = if($n){$n.BytesReceivedPersec}else{0}; $tx = if($n){$n.BytesSentPersec}else{0}
Write-Output "$cpu|$($os.FreePhysicalMemory)|$($pd[0].PercentDiskTime)|$rx|$tx|$($sys.Processes)|$($sys.Threads)|$($os.NumberOfProcesses)|$($pd[0].DiskReadBytesPersec)|$($pd[0].DiskWriteBytesPersec)"
'''
    while True:
        with _sessions_lock:
            if sid not in _sessions: break
        entry = _sessions.get(sid); lock = _winrm_locks.get(sid)
        if not entry or not lock: break
        ws = entry.get("session")
        if not ws: time.sleep(1); continue
        try:
            with lock:
                raw = _run_ps(ws, script)
                p = raw.replace(",", ".").split("|")
                if len(p) >= 10:
                    rt = float(entry["specs"].get("ram_total_kb", 1)); rf = float(p[1] or 0)
                    _metrics_cache[sid] = {
                        "cpu": round(float(p[0] or 0), 1), "ram": round(((rt - rf) / rt) * 100, 1),
                        "disk": round(float(p[2] or 0), 1), "recv_mbps": round((float(p[3] or 0)*8)/1e6, 2),
                        "sent_mbps": round((float(p[4] or 0)*8)/1e6, 2), "processes": p[5], "threads": p[6],
                        "disk_read": round(float(p[8] or 0)/1048576, 2), "disk_write": round(float(p[9] or 0)/1048576, 2)
                    }
        except: entry["session"] = None
        time.sleep(1)
