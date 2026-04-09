"""
database.py — SQLite persistence and encryption for WinRM servers
Organized within the app/ package.
"""
import sqlite3, os
from cryptography.fernet import Fernet

# Path calculation: app/ is one level deep. Data is in ../data/
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.path.join(_BASE_DIR, "data")
_DB       = os.path.join(_DATA_DIR, "servers.db")
_KEY_FILE = os.path.join(_DATA_DIR, ".fernet.key")

# Ensure data directory exists
if not os.path.exists(_DATA_DIR):
    os.makedirs(_DATA_DIR)

# ------------------------------------------------------------------
# Fernet key management
# ------------------------------------------------------------------
def _get_fernet():
    if os.path.isfile(_KEY_FILE):
        with open(_KEY_FILE, "rb") as f:
            key = f.read().strip()
    else:
        key = Fernet.generate_key()
        with open(_KEY_FILE, "wb") as f:
            f.write(key)
    return Fernet(key)

_fernet = _get_fernet()

def encrypt_password(plain: str) -> str:
    return _fernet.encrypt(plain.encode("utf-8")).decode("utf-8")

def decrypt_password(cipher: str) -> str:
    return _fernet.decrypt(cipher.encode("utf-8")).decode("utf-8")

# ------------------------------------------------------------------
# Database init
# ------------------------------------------------------------------
def _conn():
    c = sqlite3.connect(_DB)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c

def init_db():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                alias        TEXT    NOT NULL UNIQUE,
                ip           TEXT    NOT NULL UNIQUE,
                username     TEXT    NOT NULL,
                password_enc TEXT    NOT NULL
            )
        """)
        c.commit()

# Run on import initialization
init_db()

# ------------------------------------------------------------------
# CRUD Operations
# ------------------------------------------------------------------
def get_all_servers():
    with _conn() as c:
        rows = c.execute("SELECT id, alias, ip, username FROM servers ORDER BY id").fetchall()
    return [dict(r) for r in rows]

def get_server(server_id: int):
    with _conn() as c:
        row = c.execute("SELECT * FROM servers WHERE id=?", (server_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["password"] = decrypt_password(d.pop("password_enc"))
    return d

def add_server(alias: str, ip: str, username: str, password: str) -> dict:
    enc = encrypt_password(password)
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO servers (alias, ip, username, password_enc) VALUES (?,?,?,?)",
            (alias, ip, username, enc)
        )
        c.commit()
        return {"id": cur.lastrowid, "alias": alias, "ip": ip, "username": username}

def update_server(server_id: int, alias: str, ip: str, username: str, password: str = None) -> bool:
    with _conn() as c:
        if password:
            enc = encrypt_password(password)
            c.execute(
                "UPDATE servers SET alias=?, ip=?, username=?, password_enc=? WHERE id=?",
                (alias, ip, username, enc, server_id)
            )
        else:
            c.execute(
                "UPDATE servers SET alias=?, ip=?, username=? WHERE id=?",
                (alias, ip, username, server_id)
            )
        c.commit()
        return c.total_changes > 0

def delete_server(server_id: int) -> bool:
    with _conn() as c:
        c.execute("DELETE FROM servers WHERE id=?", (server_id,))
        c.commit()
        return c.total_changes > 0
