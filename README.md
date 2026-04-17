# 🌸 FlowerNode — Monitor de Servidores Windows

Sistema de monitorización en tiempo real para servidores Windows, con panel web NOC, agente de reporte autónomo y detección automática de servicios DHCP.

## ✨ Características

- **Dashboard NOC en tiempo real** — Panel web con métricas de CPU, RAM y Disco
- **Agente autónomo** — Ejecutable ligero que reporta desde cada servidor
- **Monitorización DHCP** — Detección automática de ámbitos y ocupación de IPs
- **Streaming WinRM** — Conexión directa para métricas detalladas
- **Sistema de alertas** — Notificaciones SSE en tiempo real cuando un recurso supera el 80%
- **Heatmap visual** — Vista de calor del estado de toda la flota
- **Historial de incidentes** — Registro persistente con paginación

## 📋 Requisitos

- Python 3.12+
- PostgreSQL 15+
- Servidores Windows con WinRM habilitado

## 🚀 Instalación

```bash
# 1. Instalar dependencias
pip install -r requirements.txt

# 2. Configurar base de datos
#    Crear la base de datos PostgreSQL 'winrm_monitor'
#    y configurar las credenciales en el archivo .env

# 3. Ejecutar
python run.py
```

## ⚙️ Configuración

Crear un archivo `.env` en la raíz del proyecto:

```env
DATABASE_URL=postgresql://usuario:contraseña@localhost:5432/winrm_monitor
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASS=tu_contraseña
PG_DB=winrm_monitor
```

## 🖥️ Configuración WinRM en Servidores Windows

Ejecutar en PowerShell como Administrador en cada servidor a monitorizar:

```powershell
# 1. Activar WinRM
Enable-PSRemoting -Force

# 2. Permitir conexiones remotas
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "*" -Force

# 3. Habilitar autenticación básica
winrm set winrm/config/service/auth '@{Basic="true"}'

# 4. Permitir tráfico HTTP (solo red local)
winrm set winrm/config/service '@{AllowUnencrypted="true"}'

# 5. Ampliar tamaño máximo de paquetes (evita Error 400)
Set-Item WSMan:\localhost\MaxEnvelopeSizekb -Value 2048
```

## 📁 Estructura del Proyecto

```
proyecto/
├── run.py                    # Punto de entrada de la aplicación
├── requirements.txt          # Dependencias de Python
├── .env                      # Variables de entorno (no versionado)
│
├── app/                      # Backend Flask
│   ├── __init__.py           # Factoría de la aplicación
│   ├── routes.py             # Rutas API y lógica de negocio
│   ├── database.py           # Capa de acceso a datos (PostgreSQL)
│   └── utils.py              # Filtros de logging
│
├── agente/                   # Agente autónomo para servidores
│   └── node_agent.py         # Script del agente (se compila a .exe)
│
├── deployment/               # Scripts de despliegue del agente
│   ├── build_agent.ps1       # Compilar agente con PyInstaller
│   ├── Deploy-FlowerAgent.ps1# Instalación remota del agente
│   ├── README.md             # Guía de despliegue
│   └── FlowerNodeAgent.exe   # Ejecutable compilado
│
├── static/                   # Recursos web estáticos
│   ├── css/style.css         # Estilos del dashboard
│   ├── js/app.js             # Lógica del frontend
│   ├── fonts/                # Tipografías personalizadas
│   └── img/                  # Imágenes y logos
│
└── templates/                # Plantillas HTML
    └── index.html            # Página principal (SPA)
```

## 🔑 Agente FlowerNode

El agente es un ejecutable ligero que se instala en cada servidor Windows:

```powershell
# Compilar el agente (desde la carpeta deployment/)
.\build_agent.ps1

# Desplegar en un servidor remoto
.\Deploy-FlowerAgent.ps1
```

Consulta `deployment/README.md` para instrucciones detalladas.
