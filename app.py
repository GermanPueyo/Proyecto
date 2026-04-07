"""
WinRM Server Monitor — Flask Backend
=====================================
API REST que mantiene sesiones WinRM por cliente y expone endpoints
para conectar, obtener specs estáticas, métricas en tiempo real y discos.
"""
from flask import Flask, render_template, request, jsonify, session, send_from_directory
import winrm
import os, secrets, threading, traceback

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = "winrm-monitor-key-2026"

# ------------------------------------------------------------------
# Almacén de sesiones WinRM activas  (sid → data)
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
    # Si la sesión WinRM no existe, recrearla desde las credenciales guardadas
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
# Rutas de páginas
# ------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/logo")
def logo():
    base = os.path.dirname(__file__)
    if os.path.isfile(os.path.join(base, "tyler.svg")):
        return send_from_directory(base, "tyler.svg", mimetype="image/svg+xml")
    for ext in ["png", "jpg", "jpeg"]:
        fname = f"artworks-000137781576-i5dhyd-t500x500.{ext}"
        if os.path.isfile(os.path.join(base, fname)):
            return send_from_directory(base, fname)
    return "", 404

# ------------------------------------------------------------------
# API — Conexión
# ------------------------------------------------------------------
@app.route("/api/connect", methods=["POST"])
def api_connect():
    data = request.get_json(force=True)
    ip   = data.get("ip", "").strip()
    user = data.get("user", "").strip()
    pwd  = data.get("password", "")

    if not ip or not user or not pwd:
        return jsonify({"ok": False, "error": "Todos los campos son obligatorios"}), 400

    try:
        ws = winrm.Session(
            ip, auth=(user, pwd),
            transport="ntlm",
            server_cert_validation="ignore"
        )
        script = r'''
$c  = Get-CimInstance Win32_Processor
$os = Get-CimInstance Win32_OperatingSystem
$d  = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$l2 = ($c | Measure-Object L2CacheSize -Sum).Sum
$l3 = ($c | Measure-Object L3CacheSize -Sum).Sum
Write-Output (
    "$($c[0].Name)|" +
    "$($c[0].NumberOfCores)|" +
    "$($c[0].NumberOfLogicalProcessors)|" +
    "$($c[0].MaxClockSpeed)|" +
    "$($os.TotalVisibleMemorySize)|" +
    "$($d.Size)|" +
    "$l2|$l3|" +
    "$($c[0].VirtualizationFirmwareEnabled)|" +
    "$($os.Caption) $($os.Version)"
)
'''
        raw = _run_ps(ws, script)
        p = raw.split("|")
        if len(p) < 10:
            raise ValueError(f"Respuesta incompleta del servidor: {raw}")

        specs = {
            "cpu_name":     p[0],
            "cpu_cores":    p[1],
            "cpu_logical":  p[2],
            "cpu_speed":    p[3],
            "ram_total_kb": p[4],
            "disk_total_b": p[5],
            "cpu_l2_kb":    p[6],
            "cpu_l3_kb":    p[7],
            "cpu_virt":     p[8],
            "os_version":   p[9],
        }

        sid = secrets.token_hex(16)
        with _sessions_lock:
            _sessions[sid] = {
                "session": ws,
                "specs": specs,
                "ip": ip,
                "user": user,
                "pwd": pwd,
            }
            _winrm_locks[sid] = threading.Lock()

        import time
        t = threading.Thread(target=_bg_poller, args=(sid,), daemon=True)
        _bg_threads[sid] = t
        t.start()

        session["sid"] = sid
        return jsonify({"ok": True, "sid": sid, "specs": specs})

    except Exception as exc:
        app.logger.error(f"CONNECT ERROR: {traceback.format_exc()}")
        return jsonify({"ok": False, "error": str(exc)}), 401

# ------------------------------------------------------------------
# API — Desconexión
# ------------------------------------------------------------------
@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    sid = session.pop("sid", None) or (request.get_json(force=True) or {}).get("sid")
    if sid:
        with _sessions_lock:
            _sessions.pop(sid, None)
            _winrm_locks.pop(sid, None)
            _metrics_cache.pop(sid, None)
    return jsonify({"ok": True})

# ------------------------------------------------------------------
def _bg_poller(sid):
    import time
    script = r'''
try {
    $cpu = (Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    if($null -eq $cpu){$cpu=0}
    $os  = Get-WmiObject Win32_OperatingSystem
    $pd  = Get-WmiObject Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    $sys = Get-WmiObject Win32_PerfFormattedData_PerfOS_System

    $rx = 0; $tx = 0
    try {
        $n = Get-WmiObject Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | Select-Object -First 1
        if($n){ $rx = $n.BytesReceivedPersec; $tx = $n.BytesSentPersec }
    } catch { }

    $drt = 0; $dwt = 0; $dpt = 0
    if($pd){
        $drt = $pd.DiskReadBytesPersec
        $dwt = $pd.DiskWriteBytesPersec
        $dpt = $pd.PercentDiskTime
    }

    $procs = 0; $threads = 0
    if($sys){ $procs = $sys.Processes; $threads = $sys.Threads }

    Write-Output "$cpu|$($os.FreePhysicalMemory)|$dpt|$rx|$tx|$procs|$threads|$($os.NumberOfProcesses)|$drt|$dwt"
} catch {
    Write-Output "0|0|0|0|0|0|0|0|0|0"
}
'''
    while True:
        with _sessions_lock:
            if sid not in _sessions:
                break
        
        entry = _sessions.get(sid)
        if not entry: break
        
        ws = entry.get("session")
        lock = _winrm_locks.get(sid)
        if not ws or not lock:
            time.sleep(1)
            continue
            
        try:
            with lock:
                raw = _run_ps(ws, script)
                p = raw.replace(",", ".").split("|")
                if len(p) >= 10:
                    specs = entry["specs"]
                    rt = float(specs.get("ram_total_kb", 1))
                    rf = float(p[1] or 0)

                    metrics = {
                        "cpu":        round(float(p[0] or 0), 1),
                        "ram":        round(((rt - rf) / rt) * 100, 1),
                        "ram_used_gb": round((rt - rf) / (1024**2), 2),
                        "ram_free_gb": round(rf / (1024**2), 2),
                        "disk":       round(float(p[2] or 0), 1),
                        "recv_mbps":  round((float(p[3] or 0) * 8) / 1e6, 2),
                        "sent_mbps":  round((float(p[4] or 0) * 8) / 1e6, 2),
                        "processes":  p[5],
                        "threads":    p[6],
                        "handles":    p[7],
                        "disk_read":  round(float(p[8] or 0) / 1048576, 2),
                        "disk_write": round(float(p[9] or 0) / 1048576, 2),
                    }
                    _metrics_cache[sid] = metrics
        except Exception as exc:
            app.logger.error(f"POLLER ERROR: {exc}")
            entry["session"] = None
        
        time.sleep(0.5)

@app.route("/api/metrics")
def api_metrics():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"):
        return jsonify({"ok": False, "error": "No conectado"}), 401
    
    data = _metrics_cache.get(sid)
    if not data:
        data = {
            "cpu": 0, "ram": 0, "ram_used_gb": 0, "ram_free_gb": 0, "disk": 0,
            "recv_mbps": 0, "sent_mbps": 0, "processes": 0, "threads": 0, 
            "handles": 0, "disk_read": 0, "disk_write": 0
        }
    return jsonify({"ok": True, **data})

# ------------------------------------------------------------------
# API — Listado de Discos
# ------------------------------------------------------------------
@app.route("/api/disks")
def api_disks():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"):
        return jsonify({"ok": False, "error": "No conectado"}), 401

    script = r'''
Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    $total = [math]::Round($_.Size / 1GB, 2)
    $free  = [math]::Round($_.FreeSpace / 1GB, 2)
    $used  = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 2)
    $pct   = if($_.Size -gt 0){ [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 1) } else { 0 }
    Write-Output "$($_.DeviceID)|$total|$free|$used|$pct|$($_.FileSystem)|$($_.VolumeName)"
}
'''
    lock = _winrm_locks.get(sid)
    if not lock:
        return jsonify({"ok": False, "error": "Sesión inválida"}), 401

    with lock:
        try:
            raw = _run_ps(entry["session"], script)
            disks = []
            for line in raw.strip().splitlines():
                cols = line.replace(",", ".").split("|")
                if len(cols) >= 7:
                    disks.append({
                        "letter":     cols[0],
                        "total_gb":   float(cols[1]),
                        "free_gb":    float(cols[2]),
                        "used_gb":    float(cols[3]),
                        "used_pct":   float(cols[4]),
                        "filesystem": cols[5],
                        "label":      cols[6] or "Sin etiqueta",
                    })
            return jsonify({"ok": True, "disks": disks})
        except Exception as exc:
            app.logger.error(f"DISKS ERROR: {traceback.format_exc()}")
            return jsonify({"ok": False, "error": str(exc)}), 500

# ------------------------------------------------------------------
# API — DHCP
# ------------------------------------------------------------------
@app.route("/api/dhcp")
def api_dhcp():
    sid = request.args.get("sid") or session.get("sid")
    entry = _get_ws(sid)
    if not entry or not entry.get("session"):
        return jsonify({"ok": False, "error": "No conectado"}), 401

    script = r'''
$svc = Get-Service dhcpserver -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Output "NO_DHCP_ROLE"
} else {
    try {
        $scopes = Get-DhcpServerv4Scope -ErrorAction SilentlyContinue
        if (-not $scopes) {
            Write-Output "NO_SCOPES"
        } else {
            foreach ($s in $scopes) {
                $stats = Get-DhcpServerv4ScopeStatistics -ScopeId $s.ScopeId -ErrorAction SilentlyContinue
                Write-Output "$($s.ScopeId)|$($s.Name)|$($s.StartRange)|$($s.EndRange)|$($s.SubnetMask)|$($stats.Free)|$($stats.InUse)|$($stats.PercentageInUse)"
            }
        }
    } catch {
        Write-Output "ERROR_QUERYING"
    }
}
'''
    lock = _winrm_locks.get(sid)
    if not lock:
        return jsonify({"ok": False, "error": "Sesión inválida"}), 401

    with lock:
        try:
            raw = _run_ps(entry["session"], script)
            raw = raw.strip()
            
            if "NO_DHCP_ROLE" in raw or "ERROR_QUERYING" in raw:
                return jsonify({"ok": True, "dhcp_installed": False})
            if "NO_SCOPES" in raw:
                return jsonify({"ok": True, "dhcp_installed": True, "scopes": []})
                
            scopes = []
            for line in raw.splitlines():
                cols = line.split("|")
                if len(cols) >= 8:
                    try:
                        pct = round(float(cols[7].replace(",", ".")), 2)
                    except:
                        pct = 0.0
                    scopes.append({
                        "scope_id": cols[0],
                        "name": cols[1],
                        "start_range": cols[2],
                        "end_range": cols[3],
                        "subnet_mask": cols[4],
                        "free": int(cols[5]) if cols[5].isdigit() else 0,
                        "in_use": int(cols[6]) if cols[6].isdigit() else 0,
                        "pct_in_use": pct,
                    })
            return jsonify({"ok": True, "dhcp_installed": True, "scopes": scopes})
        except Exception as exc:
            app.logger.error(f"DHCP ERROR: {traceback.format_exc()}")
            return jsonify({"ok": False, "error": str(exc)}), 500

# ------------------------------------------------------------------
# API — DHCP IPs
# ------------------------------------------------------------------
@app.route("/api/dhcp/ips")
def api_dhcp_ips():
    import ipaddress
    sid = request.args.get("sid") or session.get("sid")
    scope_id = request.args.get("scope")
    entry = _get_ws(sid)
    if not entry or not entry.get("session") or not scope_id:
        return jsonify({"ok": False, "error": "Parámetros inválidos"}), 401

    script = f'''
$scope = Get-DhcpServerv4Scope -ScopeId "{scope_id}" -ErrorAction Stop
Write-Output "$($scope.StartRange)|$($scope.EndRange)"
$leases = Get-DhcpServerv4Lease -ScopeId "{scope_id}" -ErrorAction SilentlyContinue
if ($leases) {{
    foreach ($l in $leases) {{ Write-Output $l.IPAddress.IPAddressToString }}
}}
'''
    lock = _winrm_locks.get(sid)
    if not lock:
        return jsonify({"ok": False, "error": "Sesión inválida"}), 401

    with lock:
        try:
            raw = _run_ps(entry["session"], script).strip()
            if not raw:
                raise ValueError("Respuesta inválida")
                
            lines = [L.strip() for L in raw.splitlines() if L.strip()]
            if "|" not in lines[0]:
                raise ValueError("Respuesta inválida")
                
            start_str, end_str = lines[0].split("|")
            used_ips = set(lines[1:])
            
            start_ip = int(ipaddress.IPv4Address(start_str))
            end_ip = int(ipaddress.IPv4Address(end_str))
            
            if (end_ip - start_ip) > 4096:
                return jsonify({"ok": False, "error": "Rango demasiado grande (>4096). Imposible de visualizar."}), 400
                
            ips_list = []
            for ip_int in range(start_ip, end_ip + 1):
                ip_s = str(ipaddress.IPv4Address(ip_int))
                ips_list.append({
                    "ip": ip_s,
                    "free": ip_s not in used_ips
                })
                
            return jsonify({"ok": True, "ips": ips_list})
        except Exception as exc:
            app.logger.error(f"DHCP IPS ERROR: {traceback.format_exc()}")
            return jsonify({"ok": False, "error": str(exc)}), 500

# ------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
