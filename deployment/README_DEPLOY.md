# Guía de Despliegue: FlowerNode Agent (DevOps)

Este directorio contiene las herramientas necesarias para empaquetar y desplegar el agente de monitorización de forma profesional en flotas de servidores Windows.

## 📋 Requisitos Previos

1.  **Entorno de Compilación (Tu PC):**
    *   Python 3.10+
    *   Librerías: `pip install pyinstaller psutil requests`
2.  **Preparación de Assets (Muy Importante):**
    *   No necesitas herramientas externas. Solo asegúrate de tener el ejecutable generado en el Paso 1.

## 🛠️ Paso 1: Compilación del Ejecutable

Ejecuta el script de compilación para generar el agente invisible:

```powershell
.\build_agent.ps1
```

Esto generará un archivo llamado `FlowerNodeAgent.exe` en esta misma carpeta. Este archivo es **independiente** y contiene todo lo necesario para ejecutarse sin necesidad de instalar Python en los servidores remotos.

## 🚀 Paso 2: Despliegue en Servidores

Para desplegar en un servidor, asegúrate de que la carpeta `deployment/` contenga:
- `FlowerNodeAgent.exe` (generado en el paso anterior)
- `Deploy-FlowerAgent.ps1`
- `nssm.exe`

### Opción A: Ejecución Manual (Local)
Copia estos 3 archivos al servidor remoto y ejecuta PowerShell como Administrador:
```powershell
.\Deploy-FlowerAgent.ps1
```

### Opción B: Despliegue Centralizado (40 Servidores)
Desde tu estación de trabajo (si tienes permisos de Admin de Dominio o WinRM habilitado), usa:

```powershell
$Servers = @("SRV-01", "SRV-02", "SRV-03") # Lista de tus 40 servidores
Invoke-Command -ComputerName $Servers -FilePath .\Deploy-FlowerAgent.ps1
```

## 🔍 Verificación

1.  **Servicio:** Abre `services.msc` y busca "FlowerNodeAgent". Debe estar en estado "En ejecución" e inicio "Automático".
2.  **Invisibilidad:** El proceso se ejecutará bajo el usuario `SYSTEM`. No aparecerán ventanas ni iconos en la barra de tareas de los usuarios conectados.
3.  **Resiliencia:** Si matas el proceso desde el Administrador de Tareas, el servicio se reiniciará automáticamente tras 60 segundos.

---
**Ingeniería DevOps FlowerBoy** 🌻🛡️
