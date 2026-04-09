from flask import render_template, request, jsonify, session, send_from_directory, current_app, Blueprint
import winrm
import os, secrets, threading, traceback, socket, ipaddress, warnings, logging

# Suppress PyWinRM CLIXML UserWarnings that pollute the terminal in Spanish Windows
warnings.filterwarnings("ignore", category=UserWarning, module="winrm")
logger = logging.getLogger(__name__)

from .database import get_all_servers, get_server, add_server, update_server, delete_server

main_bp = Blueprint('main', __name__)

# ------------------------------------------------------------------
# Global caches and locks (Moved from app.py)
# ------------------------------------------------------------------
_sessions = {}
_sessions_lock = threading.Lock()
_metrics_cache = {}
_bg_threads = {}
_net_history = {} # sid -> {'rx': val, 'tx': val, 'time': float}

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
    
    # Duplicate check
    all_srv = get_all_servers()
    if any(s["alias"].lower() == alias.lower() for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe un servidor con ese nombre (Alias)"}), 400
    if any(s["ip"] == ip for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe un servidor con esa dirección IP"}), 400

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
    
    # Duplicate check (excluding self)
    all_srv = get_all_servers()
    if any(s["alias"].lower() == alias.lower() and s["id"] != sid for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe otro servidor con ese nombre (Alias)"}), 400
    if any(s["ip"] == ip and s["id"] != sid for s in all_srv):
        return jsonify({"ok": False, "error": "Ya existe otro servidor con esa dirección IP"}), 400

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
            server_cert_validation="ignore",
            read_timeout_sec=30,
            operation_timeout_sec=25
        )
        # Powerhell Script
        script = r'''
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue';
try {
    $c  = Get-CimInstance Win32_Processor -EA Stop
    $os = Get-CimInstance Win32_OperatingSystem -EA Stop
    $d  = try { Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -EA Stop } catch { $null }
    $cs = Get-CimInstance Win32_ComputerSystem -EA Stop
    $net = try { Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" -EA Stop } catch { @() }
    
    $uptime = (Get-Date) - $os.LastBootUpTime
    $uptimeStr = "$($uptime.Days) d, $($uptime.Hours) h, $($uptime.Minutes) m"
    $role = if ($cs.PartOfDomain) { "Dominio" } else { "Grupo de Trabajo" }
    $l2 = ($c | Measure-Object L2CacheSize -Sum).Sum
    $l3 = ($c | Measure-Object L3CacheSize -Sum).Sum
    
    $netAdapters = @()
    foreach ($n in $net) {
        $ipv4s = $n.IPAddress | Where-Object { $_ -match "\." }
        $ip = if($ipv4s){$ipv4s -join ", "}else{"No disponible"}
        $gws = $n.DefaultIPGateway | Where-Object { $_ -match "\." }
        $gw = if($gws){$gws -join ", "}else{"No disponible"}
        $dnss = $n.DNSServerSearchOrder | Where-Object { $_ -match "\." }
        $dns = if($dnss){$dnss -join ", "}else{"No disponible"}
        $mac = if($n.MACAddress){$n.MACAddress}else{"No disponible"}
        $desc = if($n.Description){$n.Description}else{"Adaptador Desconocido"}
        $netAdapters += @{ desc=$desc; ip=$ip; mac=$mac; gw=$gw; dns=$dns }
    }
    
    $mem = try { Get-CimInstance Win32_PhysicalMemory -EA Stop } catch { $null }
    $speed = if ($mem) { ($mem | Select-Object -First 1).Speed } else { 0 }
    $manufacturer = if ($cs.Manufacturer) { $cs.Manufacturer } else { "Desconocido" }
    
    $specs = @{
        ok = $true
        cpu_name = $c[0].Name
        cpu_cores = $c[0].NumberOfCores
        cpu_logical = $c[0].NumberOfLogicalProcessors
        cpu_speed = $c[0].MaxClockSpeed
        ram_total_kb = $os.TotalVisibleMemorySize
        disk_total_b = if($d){$d.Size}else{0}
        cpu_l2_kb = $l2
        cpu_l3_kb = $l3
        cpu_virt = "$($c[0].VirtualizationFirmwareEnabled)"
        os_version = "$($os.Caption) $($os.Version)"
        uptime = $uptimeStr
        hostname = $cs.Name
        domain_role = $role
        domain = $cs.Domain
        net_adapters = $netAdapters
        ram_speed = $speed
        manufacturer = $manufacturer
        server_roles = ""
    }
    Write-Output ($specs | ConvertTo-Json -Depth 5 -Compress)
} catch {
    $err = $_.Exception.Message.Replace('"', '\"').Replace("`n", " ")
    Write-Output "{\`"ok\`":false,\`"error\`":\`"Excepcion de PS: $err\`"}"
}
'''
        import json
        raw = _run_ps(ws, script)
        try:
            data = json.loads(raw)
            if not data.get("ok"): raise ValueError(data.get("error", "Error interno PS"))
            specs = data
        except Exception as e:
            raise ValueError(f"No se pudo analizar la estructura del servidor: {str(e)}")

        sid = secrets.token_hex(16)
        with _sessions_lock:
            _sessions[sid] = {"session": ws, "specs": specs, "ip": ip, "user": user, "pwd": pwd}

        t = threading.Thread(target=_bg_poller, args=(sid,), daemon=True)
        _bg_threads[sid] = t
        t.start()
        session["sid"] = sid
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
def _bg_poller(sid):
    import json, time, base64

    # High-speed streaming CIM poller (Universal Language Compatibility)
    script = r'''
$WarningPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue'
while($true) {
  try {
    # We fetch metrics using standard CIM classes
    $c = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -Property PercentProcessorTime).PercentProcessorTime
    $o = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory
    $d = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -Property PercentDiskTime).PercentDiskTime
    # Use FormattedData to get the instantaneous bps rate directly
    $ni = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -Property BytesTotalPersec | Where-Object { $_.Name -notmatch 'Loopback' }
    $nt = ($ni | Measure-Object BytesTotalPersec -Sum).Sum
    
    # Use an object and ConvertTo-Json to ensure correct JSON formatting (dots vs commas)
    $data = @{
      ok = $true
      cpu = [Math]::Round([double]$c, 1)
      ramFreeMB = [Math]::Round([double]$o.FreePhysicalMemory/1024, 0)
      dTime = [Math]::Round([Math]::Min(100, [double]$d), 1)
      netTotal = [double]$nt
    }
    Write-Output ($data | ConvertTo-Json -Compress)
  } catch {
    Write-Output (@{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)
  }
  Start-Sleep -Milliseconds 450
}
'''
    encoded_ps = base64.b64encode(script.encode('utf_16_le')).decode('ascii')
    # ... (Rest of the logic remains the same)

    entry = _sessions.get(sid)
    if not entry: return
    ws = entry.get("session")
    if not ws: return
    protocol = ws.protocol
    shell_id = None; command_id = None

    def start_stream():
        nonlocal shell_id, command_id
        try:
            if shell_id: 
                try: protocol.close_shell(shell_id)
                except: pass
            shell_id = protocol.open_shell()
            command_id = protocol.run_command(shell_id, 'powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',encoded_ps])
            return True
        except Exception as e: 
            logger.error(f"STREAM START FAILED for {sid}: {e}")
            return False

    if not start_stream(): return

    buffer = ""
    logger.info(f"Industrial Stream started (CIM Mode) for {sid}")

    try:
        while True:
            with _sessions_lock:
                if sid not in _sessions: break

            try:
                stdout, stderr, return_code, command_done = protocol.get_command_output_raw(shell_id, command_id)
                if stdout:
                    raw_str = stdout.decode('utf-8', errors='ignore')
                    buffer += raw_str
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1); line = line.strip()
                        if not line or not line.startswith("{"): continue
                        try:
                            data = json.loads(line)
                            if data.get("ok"):
                                now = time.perf_counter()
                                rt_mb = float(entry["specs"].get("ram_total_kb", 1024*1024)) / 1024
                                rf_mb = float(data.get("ramFreeMB") or 0)
                                mbps = (float(data.get("netTotal") or 0) * 8) / 1e6
                                
                                _metrics_cache[sid] = {
                                    "cpu": data.get("cpu", 0),
                                    "ram": round(((rt_mb - rf_mb) / rt_mb) * 100, 1) if rt_mb > 0 else 0,
                                    "disk": data.get("dTime", 0),
                                    "recv_mbps": round(mbps * 0.7, 2),
                                    "sent_mbps": round(mbps * 0.3, 2),
                                    "processes": entry["specs"].get("procs", 0),
                                    "threads": 0, "disk_read": 0, "disk_write": 0
                                }
                            else:
                                logger.warning(f"PS Stream Error from server {sid}: {data.get('error')}")
                        except Exception as je: 
                            logger.error(f"JSON Parse error for {sid}: {je} | Raw: {line[:60]}...")
                
                if command_done:
                    logger.info(f"Stream command finished for {sid}, restarting...")
                    if not start_stream(): break
                time.sleep(0.05)
            except Exception as e:
                logger.error(f"Streaming loop error for {sid}: {e}")
                time.sleep(1)
                if not start_stream(): break
    finally:
        if shell_id:
            try: 
                protocol.close_shell(shell_id)
            except: 
                pass
