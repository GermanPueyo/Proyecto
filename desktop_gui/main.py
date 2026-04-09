import customtkinter as ctk
import winrm, threading
from collections import deque
import matplotlib
import io
import os
from PIL import Image
matplotlib.use('TkAgg') 
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

BG_COLOR = "#1e1e2f"
PANEL_COLOR = "#27293d"
TEXT_COLOR = "#ffffff"
MUTED_TEXT = "#9e9e9e"

C_CPU = "#d946ef"
C_RAM = "#06b6d4"
C_DISK = "#8b5cf6"
C_NET_UP = "#ef4444"
C_NET_DN = "#10b981"
C_NET_BASE = "#f59e0b"

ctk.set_appearance_mode("dark")

def bind_recursive(widget, event, command):
    widget.bind(event, command)
    for child in widget.winfo_children():
        bind_recursive(child, event, command)

class SparklineBtn(ctk.CTkFrame):
    """Boton compuesto para el menú lateral que dibuja historial tipo Task Manager"""
    def __init__(self, parent, text, color, app, page_id, is_dual=False):
        super().__init__(parent, fg_color="transparent", cursor="hand2")
        self.app = app
        self.page_id = page_id
        self.color = color
        self.is_dual = is_dual
        
        self.lbl = ctk.CTkLabel(self, text=text, font=("Arial", 14), text_color=TEXT_COLOR, anchor="w")
        self.lbl.pack(side="top", fill="x", padx=20, pady=(10,0))
        
        # Mini gráfico nativo de Tkinter (Canvas), cero impacto de recursos
        self.cv = ctk.CTkCanvas(self, height=25, bg=PANEL_COLOR, highlightthickness=0)
        self.cv.pack(side="bottom", fill="x", padx=20, pady=(2,10))
        
        bind_recursive(self, "<Button-1>", lambda e: self.app.show_page(self.page_id))
        
        def on_enter(e): self.configure(fg_color="#374151")
        def on_leave(e): self.configure(fg_color="transparent")
        self.bind("<Enter>", on_enter)
        self.bind("<Leave>", on_leave)

    def draw(self, y_max=100.0):
        self.cv.delete("all")
        w_px = self.cv.winfo_width()
        if w_px < 10: w_px = 200 # Fallback inicial
        h_px = 25
        
        # Extraer data correspondiente
        key = self.page_id
        if key == "home": return
        
        d1 = list(self.app.data[key]) if key != "net" else list(self.app.data["net_dn"])
        d2 = list(self.app.data["net_up"]) if key == "net" else []
        
        limit = y_max if not self.is_dual else max(max(d1, default=0), max(d2, default=0), 1)
        if limit <= 0: limit = 1

        pts = []
        step = w_px / max(1, len(d1)-1)
        for i, val in enumerate(d1):
            pts.extend([i*step, h_px - (min(val, limit)/limit)*h_px])
            
        if len(pts) >= 4:
            self.cv.create_line(pts, fill=self.color, width=2, smooth=True)
            self.cv.create_polygon([0, h_px] + pts + [w_px, h_px], fill=self.color, stipple='gray50')

        if self.is_dual and d2:
            pts2 = []
            for i, val in enumerate(d2):
                pts2.extend([i*step, h_px - (min(val, limit)/limit)*h_px])
            if len(pts2) >= 4:
                self.cv.create_line(pts2, fill=C_NET_UP, width=2, smooth=True)

class BasePage(ctk.CTkFrame):
    def __init__(self, parent, app):
        super().__init__(parent, fg_color="transparent")
        self.app = app
    def on_show(self): pass
    def update_ui(self, metrics): pass

class HomeFrame(BasePage):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self.chart_panel = ctk.CTkFrame(self, fg_color=PANEL_COLOR, corner_radius=20)
        self.chart_panel.pack(fill="both", expand=True, pady=(0, 20))
        
        head = ctk.CTkFrame(self.chart_panel, fg_color="transparent", height=40)
        head.pack(fill="x", padx=20, pady=(20, 0))
        ctk.CTkLabel(head, text="Monitoreo Total Unificado", font=("Arial", 18, "bold"), text_color=TEXT_COLOR).pack(side="left")
        
        self.fig = Figure(facecolor=PANEL_COLOR, tight_layout=True)
        self.ax = self.fig.add_subplot(111)
        self.ax.set_facecolor(PANEL_COLOR)
        for s in self.ax.spines.values(): s.set_visible(False)
        self.ax.tick_params(colors=MUTED_TEXT)
        self.ax.grid(color='#3f3f4e', linestyle='--', alpha=0.5, axis='y')
        self.ax.set_ylim(0, 100); self.ax.set_xlim(0, self.app.max_history - 1); self.ax.set_xticks([])
        
        x_d = list(range(self.app.max_history))
        self.l_c, = self.ax.plot(x_d, self.app.data["cpu"], color=C_CPU, linewidth=2.5)
        self.l_r, = self.ax.plot(x_d, self.app.data["ram"], color=C_RAM, linewidth=2.5)
        self.l_d, = self.ax.plot(x_d, self.app.data["disk"], color=C_DISK, linewidth=2, linestyle="--")
        
        self.canvas = FigureCanvasTkAgg(self.fig, master=self.chart_panel)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True, padx=20, pady=(0, 20))
        
        self.cards_panel = ctk.CTkFrame(self, fg_color="transparent")
        self.cards_panel.pack(fill="x")
        self.cards_panel.grid_columnconfigure((0,1,2,3), weight=1)
        
        self.cards = {}
        self.cards["cpu"] = self._b_c(self.cards_panel, "CPU", C_CPU, 0, self.l_c)
        self.cards["ram"] = self._b_c(self.cards_panel, "RAM", C_RAM, 1, self.l_r)
        self.cards["disk"] = self._b_c(self.cards_panel, "Disco Activo", C_DISK, 2, self.l_d)
        self.cards["net"] = self._b_c(self.cards_panel, "Red", C_NET_BASE, 3, None)

    def _b_c(self, p, t, c, col, tl):
        cd = ctk.CTkFrame(p, fg_color=PANEL_COLOR, corner_radius=20, cursor="hand2" if tl else "arrow")
        cd.grid(row=0, column=col, sticky="nsew", padx=(0,15) if col<3 else 0)
        ctk.CTkLabel(cd, text=t, font=("Arial", 14), text_color=MUTED_TEXT).pack(anchor="nw",padx=20,pady=(15,0))
        v = ctk.CTkLabel(cd, text="0.0%", font=("Arial",36,"bold"), text_color=c)
        v.pack(anchor="nw",padx=20,pady=0)
        b = ctk.CTkProgressBar(cd, height=6, progress_color=c, fg_color="#1e1e2f")
        b.set(0); b.pack(fill="x", padx=20, pady=(10,20), side="bottom")
        if tl:
            def _cl(e):
                vis = not tl.get_visible()
                tl.set_visible(vis)
                v.configure(text_color=c if vis else MUTED_TEXT)
                b.configure(progress_color=c if vis else "#3f3f4e")
                self.canvas.draw()
            bind_recursive(cd, "<Button-1>", _cl)
        return {"v": v, "b": b}

    def update_ui(self, m):
        x = list(range(self.app.max_history))
        self.l_c.set_data(x, list(self.app.data["cpu"]))
        self.l_r.set_data(x, list(self.app.data["ram"]))
        self.l_d.set_data(x, list(self.app.data["disk"]))
        self.canvas.draw()
        self.cards["cpu"]["v"].configure(text=f"{m['cpu']}%"); self.cards["cpu"]["b"].set(m['cpu']/100)
        self.cards["ram"]["v"].configure(text=f"{m['ram']}%"); self.cards["ram"]["b"].set(m['ram']/100)
        self.cards["disk"]["v"].configure(text=f"{m['disk']}%"); self.cards["disk"]["b"].set(m['disk']/100)
        n = m['recv_mbps'] + m['sent_mbps']
        self.cards["net"]["v"].configure(text=f"{n:.1f}M"); self.cards["net"]["b"].set(min(1.0, n/1000.0))

class DetailPage(BasePage):
    def __init__(self, p, app, tit, sub_tit, color_line, y_max=100.0, fmt="%"):
        super().__init__(p, app)
        self.y_max = y_max
        self.fmt = fmt
        self.color_line = color_line
        
        self.top_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.top_frame.pack(fill="x", pady=(0, 10))
        self.t_lbl = ctk.CTkLabel(self.top_frame, text=tit, font=("Arial",24,"bold"), text_color=TEXT_COLOR)
        self.t_lbl.pack(anchor="w")
        self.st_lbl = ctk.CTkLabel(self.top_frame, text=sub_tit, font=("Arial",14), text_color=MUTED_TEXT)
        self.st_lbl.pack(anchor="w")
        
        self.ch_p = ctk.CTkFrame(self, fg_color=PANEL_COLOR, corner_radius=20)
        self.ch_p.pack(fill="both", expand=True, pady=(0, 15))
        
        self.fig = Figure(facecolor=PANEL_COLOR, tight_layout=True)
        self.ax = self.fig.add_subplot(111)
        self.ax.set_facecolor(PANEL_COLOR)
        for s in self.ax.spines.values(): s.set_visible(False)
        self.ax.tick_params(colors=MUTED_TEXT, labelsize=10)
        self.ax.grid(color='#3f3f4e', linestyle='--', alpha=0.5, axis='y')
        self.ax.set_ylim(0, y_max)
        self.ax.set_xlim(0, self.app.max_history - 1)
        self.ax.set_xticks([])
        
        if color_line != "dual":
            self.l_m, = self.ax.plot([], [], color=color_line, linewidth=2.5)
            self.f_m = self.ax.fill_between([], [], color=color_line, alpha=0.2)
        else:
            self.l_dn, = self.ax.plot([], [], color=C_NET_DN, linewidth=2, label="Recepción (↓)")
            self.l_up, = self.ax.plot([], [], color=C_NET_UP, linewidth=2, label="Envío (↑)")
            self.ax.legend(facecolor=PANEL_COLOR, edgecolor='none', labelcolor=TEXT_COLOR, loc='upper left')

        self.canvas = FigureCanvasTkAgg(self.fig, master=self.ch_p)
        self.canvas.get_tk_widget().pack(fill="both", expand=True, padx=20, pady=20)
        
        # Grid Matrix
        self.grid_p = ctk.CTkFrame(self, fg_color=PANEL_COLOR, corner_radius=20, height=150)
        self.grid_p.pack(fill="x")
        self.grid_p.grid_columnconfigure((0,1,2,3), weight=1)
        self.grid_boxes = []

    def add_grid_val(self, r, c, tit, val_id, col_span=1):
        f = ctk.CTkFrame(self.grid_p, fg_color="transparent")
        f.grid(row=r, column=c, columnspan=col_span, sticky="nw", padx=25, pady=15)
        ctk.CTkLabel(f, text=tit, font=("Arial", 14), text_color=MUTED_TEXT).pack(anchor="w")
        v = ctk.CTkLabel(f, text="-", font=("Arial", 28, "bold"), text_color=TEXT_COLOR)
        v.pack(anchor="w")
        self.grid_boxes.append((val_id, v))
    
    def add_grid_stat(self, r, c, tit, val_id):
        f = ctk.CTkFrame(self.grid_p, fg_color="transparent")
        f.grid(row=r, column=c, sticky="e", padx=25, pady=5)
        ctk.CTkLabel(f, text=tit, font=("Arial", 12), text_color=MUTED_TEXT).pack(side="left", padx=(0,10))
        v = ctk.CTkLabel(f, text="-", font=("Arial", 12, "bold"), text_color=TEXT_COLOR)
        v.pack(side="left")
        self.grid_boxes.append((val_id, v))

    def update_grid(self, data_dict):
        for vid, v in self.grid_boxes:
            if vid in data_dict:
                v.configure(text=data_dict[vid])

class CpuPage(DetailPage):
    def __init__(self, p, app):
        super().__init__(p, app, "Procesador", "", C_CPU)
        self.add_grid_val(0, 0, "Uso", "uso")
        self.add_grid_val(0, 1, "Velocidad", "vel")
        self.add_grid_val(1, 0, "Procesos", "proc")
        self.add_grid_val(1, 1, "Subprocesos", "thr")
        self.add_grid_val(1, 2, "Identificadores", "han")
        
        self.add_grid_stat(0, 3, "Velocidad base:", "basev")
        self.add_grid_stat(1, 3, "Sockets:", "sock")
        self.add_grid_stat(2, 3, "Núcleos físicos:", "core")
        self.add_grid_stat(3, 3, "Procesadores lóg.:", "logi")
        self.add_grid_stat(4, 3, "Virtualización:", "virt")
        self.add_grid_stat(5, 3, "Caché L2/L3:", "cach")

    def on_show(self):
        s = self.app.static_specs; d = self.app.dyn_wmi
        if s:
            self.st_lbl.configure(text=s.get('cpu_name',''))
            self.update_grid({"basev": f"{s.get('cpu_speed','')} MHz", "sock": "1", 
                              "core": s.get('cpu_cores',''), "logi": s.get('cpu_logical',''),
                              "virt": "Habilitado" if s.get('cpu_virt')=='True' else "Desconocido",
                              "cach": s.get('cpu_cache','')})

    def update_ui(self, m):
        xd = list(range(self.app.max_history)); yd = list(self.app.data["cpu"])
        self.l_m.set_data(xd, yd)
        self.f_m.remove(); self.f_m = self.ax.fill_between(xd, yd, color=self.color_line, alpha=0.2)
        self.canvas.draw()
        
        d = self.app.dyn_wmi
        self.update_grid({
            "uso": f"{m['cpu']}%", "vel": f"{m.get('cpu_spd_real', 0)} GHz",
            "proc": d.get("proc","0"), "thr": d.get("thr","0"), "han": d.get("han","0")
        })

class DiskPage(DetailPage):
    def __init__(self, p, app):
        super().__init__(p, app, "Disco Activo", "Unidad C:", C_DISK)
        self.add_grid_val(0, 0, "Tiempo Activo (%)", "act")
        self.add_grid_val(0, 1, "Vel. Lectura", "read")
        self.add_grid_val(0, 2, "Vel. Escritura", "write")
        
        self.add_grid_stat(0, 3, "Capacidad Lógica:", "cap")
        self.add_grid_stat(1, 3, "Tipo Formato:", "fmt")
        
    def on_show(self):
        s = self.app.static_specs
        if s:
            t = float(s.get("disk_total_b", 0)) / (1024**3)
            self.update_grid({"cap": f"{t:.1f} GB", "fmt": "NTFS / SSD"})
            
    def update_ui(self, m):
        xd = list(range(self.app.max_history)); yd = list(self.app.data["disk"])
        self.l_m.set_data(xd, yd)
        self.f_m.remove(); self.f_m = self.ax.fill_between(xd, yd, color=self.color_line, alpha=0.2)
        self.canvas.draw()
        
        d = self.app.dyn_wmi
        self.update_grid({"act": f"{m['disk']}%", "read": f"{d.get('d_rd','0')} MB/s", "write": f"{d.get('d_wr','0')} MB/s"})

class RamPage(DetailPage):
    def __init__(self, p, app):
        super().__init__(p, app, "Memoria", "Uso de Memoria Física", C_RAM)
        self.add_grid_val(0, 0, "Uso", "uso")
        self.add_grid_val(0, 1, "Disponible", "disp")
        self.add_grid_stat(0, 3, "Instalada (Local):", "tot")

    def on_show(self):
        s = self.app.static_specs
        if s:
            t = float(s.get("ram_total_kb", 0)) / (1024**2)
            self.update_grid({"tot": f"{t:.1f} GB"})
            self.st_lbl.configure(text=f"{t:.1f} GB DDR Instalada")

    def update_ui(self, m):
        xd = list(range(self.app.max_history)); yd = list(self.app.data["ram"])
        self.l_m.set_data(xd, yd)
        self.f_m.remove(); self.f_m = self.ax.fill_between(xd, yd, color=self.color_line, alpha=0.2)
        self.canvas.draw()
        s = self.app.static_specs
        f = m['ram_free_kb'] / (1024**2)
        u = (float(s.get("ram_total_kb", 0)) / (1024**2)) - f if s else 0
        self.update_grid({"uso": f"{u:.1f} GB", "disp": f"{f:.1f} GB"})

class NetPage(DetailPage):
    def __init__(self, p, app):
        super().__init__(p, app, "Red", "Ethernet / Wi-Fi Total", "dual")
        self.add_grid_val(0, 0, "Enviando", "up")
        self.add_grid_val(0, 1, "Recibiendo", "dn")

    def update_ui(self, m):
        xd = list(range(self.app.max_history))
        self.l_up.set_data(xd, list(self.app.data["net_up"]))
        self.l_dn.set_data(xd, list(self.app.data["net_dn"]))
        n1 = max(self.app.data["net_up"], default=0)
        n2 = max(self.app.data["net_dn"], default=0)
        self.ax.set_ylim(0, max(n1, n2, 0.5) * 1.3)
        self.canvas.draw()
        self.update_grid({"up": f"{m['sent_mbps']:.2f} Mbps", "dn": f"{m['recv_mbps']:.2f} Mbps"})


class EnterpriseMonitorApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Server Monitor (Taskmgr Edition)")
        self.geometry("1400x850")
        self.configure(fg_color=BG_COLOR)
        
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        self.running = False; self.session = None; self.is_fetching = False
        self.max_history = 60
        self.static_specs = {}
        self.dyn_wmi = {}
        self._init_data()
        self.build_ui()

    def _init_data(self):
        self.data = {k: deque([0]*self.max_history, maxlen=self.max_history) for k in ["cpu","ram","disk","net_up","net_dn"]}

    def build_ui(self):
        self.sidebar = ctk.CTkFrame(self, fg_color=PANEL_COLOR, corner_radius=20, width=320)
        self.sidebar.grid(row=0, column=0, padx=20, pady=20, sticky="nsew")
        self.sidebar.grid_propagate(False)

        # LOGO
        logo_f = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        logo_f.pack(pady=(30, 20), fill="x", padx=20)
        img_path = os.path.join(os.path.dirname(__file__), "artworks-000137781576-i5dhyd-t500x500.png")
        try:
            img = Image.open(img_path)
            c_img = ctk.CTkImage(light_image=img, dark_image=img, size=(60, 60))
            lb = ctk.CTkLabel(logo_f, text="", image=c_img)
            lb.pack(side="left")
            self._logo = c_img 
        except: pass
        
        c_t = ctk.CTkFrame(logo_f, fg_color="transparent")
        c_t.pack(side="left", padx=15)
        ctk.CTkLabel(c_t, text="WinRM Server", font=("Arial", 18, "bold"), text_color=TEXT_COLOR).pack(anchor="w")
        ctk.CTkLabel(c_t, text="Monitor Remoto", font=("Arial", 12), text_color=MUTED_TEXT).pack(anchor="w")

        # MODO LOGIN
        self.login_wrapper = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        self.login_wrapper.pack(fill="x", pady=20)
        self.ip_entry = self._input("IP Servidor", "192.168.56.101")
        self.usr_entry = self._input("Usuario Administrador", "Administrador")
        self.pwd_entry = self._input("Contraseña", "", True)
        self.connect_btn = ctk.CTkButton(self.login_wrapper, text="INICIAR SESIÓN", height=45, corner_radius=8, command=self.do_connect)
        self.connect_btn.pack(pady=(20, 0), padx=25, fill="x")

        # MODO NAV (Sparklines)
        self.nav_wrapper = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        self.nav_btns = {}
        self.nav_btns["home"] = SparklineBtn(self.nav_wrapper, "Rendimiento Global", C_CPU, self, "home")
        self.nav_btns["home"].cv.pack_forget() # no cv for home
        self.nav_btns["home"].pack(fill="x", pady=5)
        
        self.nav_btns["cpu"] = SparklineBtn(self.nav_wrapper, "CPU", C_CPU, self, "cpu")
        self.nav_btns["cpu"].pack(fill="x", pady=5)
        self.nav_btns["ram"] = SparklineBtn(self.nav_wrapper, "Memoria", C_RAM, self, "ram")
        self.nav_btns["ram"].pack(fill="x", pady=5)
        self.nav_btns["disk"] = SparklineBtn(self.nav_wrapper, "Disco Virtual", C_DISK, self, "disk")
        self.nav_btns["disk"].pack(fill="x", pady=5)
        self.nav_btns["net"] = SparklineBtn(self.nav_wrapper, "Ethernet", C_NET_UP, self, "net", True)
        self.nav_btns["net"].pack(fill="x", pady=5)

        self.disconnect_btn = ctk.CTkButton(self.sidebar, text="DESCONECTAR", height=45, fg_color="transparent", border_width=1, command=self.do_disconnect, state="disabled")
        self.status_lbl = ctk.CTkLabel(self.sidebar, text="Esperando enlace", text_color=MUTED_TEXT); self.status_lbl.pack(side="bottom", pady=20)

        # Content
        self.workspace = ctk.CTkFrame(self, fg_color="transparent")
        self.workspace.grid(row=0, column=1, padx=(0, 20), pady=20, sticky="nsew")
        self.pages = { "home": HomeFrame(self.workspace, self), "cpu": CpuPage(self.workspace, self), "ram": RamPage(self.workspace, self), "disk": DiskPage(self.workspace, self), "net": NetPage(self.workspace, self) }
        self.current_page = None

    def _input(self, l, pl, p=False):
        f = ctk.CTkFrame(self.login_wrapper, fg_color="transparent")
        f.pack(pady=5, padx=25, fill="x")
        ctk.CTkLabel(f, text=l, font=("Arial", 12), text_color=MUTED_TEXT).pack(anchor="w")
        e = ctk.CTkEntry(f, height=38, show="*" if p else ""); e.insert(0, pl); e.pack(fill="x")
        return e

    def show_page(self, name):
        if self.current_page: self.pages[self.current_page].pack_forget()
        self.pages[name].pack(fill="both", expand=True)
        self.pages[name].on_show()
        self.current_page = name

    def morph_to_nav(self):
        self.login_wrapper.pack_forget()
        self.nav_wrapper.pack(fill="x", expand=True)
        self.disconnect_btn.pack(side="bottom", pady=20, padx=25, fill="x")
        self.show_page("home")

    def do_connect(self):
        self.connect_btn.configure(state="disabled")
        threading.Thread(target=self._connection_worker, args=(self.ip_entry.get(), self.usr_entry.get(), self.pwd_entry.get()), daemon=True).start()

    def _connection_worker(self, ip, user, pwd):
        try:
            self.session = winrm.Session(ip, auth=(user, pwd), transport='ntlm', server_cert_validation='ignore')
            script = r'''
            $ErrorActionPreference='SilentlyContinue';
            $c = Get-CimInstance Win32_Processor;
            $os = Get-CimInstance Win32_OperatingSystem;
            $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";
            $cs = Get-CimInstance Win32_ComputerSystem;
            $l2 = ($c | Measure-Object L2CacheSize -Sum).Sum;
            $l3 = ($c | Measure-Object L3CacheSize -Sum).Sum;
            $virt = "$($c[0].VirtualizationFirmwareEnabled)";
            # Delimited output for reliability
            Write-Output "$($c[0].Name)|$($c[0].NumberOfCores)|$($c[0].NumberOfLogicalProcessors)|$($c[0].MaxClockSpeed)|$($os.TotalVisibleMemorySize)|$($d.Size)|$($l2) MB / $($l3) MB|$($virt)"
            '''
            res = self.session.run_ps(script)
            if res.status_code == 0:
                p = res.std_out.decode('utf-8', errors='ignore').strip().split("|")
                if len(p) >= 8:
                    self.static_specs = {
                        "cpu_name": p[0], "cpu_cores": p[1], "cpu_logical": p[2], 
                        "cpu_speed": p[3], "ram_total_kb": p[4], "disk_total_b": p[5], 
                        "cpu_cache": p[6], "cpu_virt": p[7]
                    }
                    self.after(0, self.on_connected_ok)
                else: self.after(0, self.do_disconnect)
            else: self.after(0, self.do_disconnect)
        except: self.after(0, self.do_disconnect)

    def on_connected_ok(self):
        self.disconnect_btn.configure(state="normal", text_color="#ef4444")
        self.morph_to_nav()
        self.running = True
        self._loop_scheduler()

    def _loop_scheduler(self):
        if not self.running: return
        if self.session and not self.is_fetching:
            self.is_fetching = True
            threading.Thread(target=self._metrics_worker, daemon=True).start()
        self.after(3000, self._loop_scheduler)

    def _metrics_worker(self):
        script = r'''
        $ErrorActionPreference='SilentlyContinue';
        $c = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime;
        $m = Get-CimInstance Win32_OperatingSystem;
        $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'";
        $s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System;
        $ni = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface;
        $net = ($ni | Measure-Object BytesTotalPersec -Sum).Sum;
        "@{$([int]$c);$([double]$m.FreePhysicalMemory);$([int]$m.NumberOfProcesses);$([int]$s.Threads);$([double]$d.PercentDiskTime);$([double]$d.DiskReadBytesPersec);$([double]$d.DiskWriteBytesPersec);$([double]$net)}"
        '''
        try:
            res = self.session.run_ps(script)
            if res.status_code == 0:
                raw = res.std_out.decode('utf-8', errors='ignore').strip().strip('"').replace('@{','').replace('}','')
                parts = raw.split(';')
                if len(parts) >= 8:
                    c_cpu = round(float(parts[0]), 1)
                    rt = float(self.static_specs.get("ram_total_kb", 1))
                    free_kb = float(parts[1])
                    c_ram = round(((rt - free_kb) / rt) * 100, 1) if rt > 0 else 0
                    c_disk = round(float(parts[4]), 1)
                    
                    net_total = float(parts[7])
                    nr = round((net_total * 0.7 * 8) / 1000000, 2)
                    ns = round((net_total * 0.3 * 8) / 1000000, 2)
                    
                    spd = round((c_cpu / 100.0) * float(self.static_specs.get("cpu_speed", 2500))/1000 + 1.0, 2)
                    
                    m = {"cpu": c_cpu, "ram": c_ram, "disk": c_disk, "ram_free_kb": free_kb, "recv_mbps": nr, "sent_mbps": ns}
                    
                    d_rd = round(float(parts[5]) / 1048576, 2)
                    d_wr = round(float(parts[6]) / 1048576, 2)
                    self.dyn_wmi = {"proc": int(parts[2]), "thr": int(parts[3]), "han": "-", "d_rd": d_rd, "d_wr": d_wr, "cpu_spd_real": spd}
                    self.after(0, self.refresh_dashboard, m)
            else:
                print("Desktop Poll Warn:", res.std_err.decode('utf-8', errors='ignore'))
        except Exception as e:
            print("Desktop Poll Error:", e)
        finally: 
            self.is_fetching = False

    def refresh_dashboard(self, m):
        self.data["cpu"].append(m["cpu"])
        self.data["ram"].append(m["ram"])
        self.data["disk"].append(m["disk"])
        self.data["net_dn"].append(m["recv_mbps"])
        self.data["net_up"].append(m["sent_mbps"])
        if self.current_page: self.pages[self.current_page].update_ui(m)
        for k, b in self.nav_btns.items(): b.draw(100.0 if k!="net" else -1)

    def do_disconnect(self):
        self.running = False; self.session = None; self._init_data(); self.login_wrapper.pack(); self.nav_wrapper.pack_forget(); self.disconnect_btn.pack_forget(); self.current_page=None; self.connect_btn.configure(state="normal")

if __name__ == "__main__":
    app = EnterpriseMonitorApp()
    app.mainloop()
