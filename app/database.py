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
        # Security: Restrict key access (Unix 600)
        try: os.chmod(_KEY_FILE, 0o600)
        except: pass
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
    c.execute("PRAGMA foreign_keys = ON")
    return c

def init_db():
    with _conn() as c:
        # 1. Create groups table
        c.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT    NOT NULL UNIQUE,
                position INTEGER NOT NULL DEFAULT 0
            )
        """)
        
        # 2. Create servers table (Updated with group_id and tags)
        c.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                alias        TEXT    NOT NULL UNIQUE,
                ip           TEXT    NOT NULL UNIQUE,
                username     TEXT    NOT NULL,
                password_enc TEXT    NOT NULL,
                group_id     INTEGER,
                tags         TEXT    DEFAULT '',
                position     INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
            )
        """)

        # 3. Migration: Handle transitioning from old 'client_group' string
        try:
            # Check if old column exists
            info = c.execute("PRAGMA table_info(servers)").fetchall()
            cols = [col['name'] for col in info]
            
            if 'client_group' in cols:
                # First ensure we have a 'group_id' column (if CREATE TABLE didn't run because it already existed)
                if 'group_id' not in cols:
                    c.execute("ALTER TABLE servers ADD COLUMN group_id INTEGER REFERENCES groups(id)")
                if 'tags' not in cols:
                    c.execute("ALTER TABLE servers ADD COLUMN tags TEXT DEFAULT ''")
                if 'position' not in cols:
                    c.execute("ALTER TABLE servers ADD COLUMN position INTEGER NOT NULL DEFAULT 0")

                # Extract existing unique groups
                old_groups = c.execute("SELECT DISTINCT client_group FROM servers WHERE client_group IS NOT NULL").fetchall()
                for row in old_groups:
                    name = row['client_group']
                    c.execute("INSERT OR IGNORE INTO groups (name) VALUES (?)", (name,))
                
                # Update servers with their new group_id
                c.execute("""
                    UPDATE servers SET group_id = (
                        SELECT id FROM groups WHERE name = servers.client_group
                    ) WHERE client_group IS NOT NULL
                """)
                
                # We could drop 'client_group' here, but SQLite doesn't support DROP COLUMN well in older versions.
                # We'll just leave it and stop using it.
        except Exception as e:
            print(f"Migration error: {e}")

        # Ensure 'General' group exists
        c.execute("INSERT OR IGNORE INTO groups (name) VALUES ('General')")
        c.commit()

# Run initialization
init_db()

# ------------------------------------------------------------------
# Group CRUD
# ------------------------------------------------------------------
def get_all_groups():
    with _conn() as c:
        rows = c.execute("SELECT * FROM groups ORDER BY position, name").fetchall()
    return [dict(r) for r in rows]

def add_group(name: str):
    with _conn() as c:
        cur = c.execute("INSERT INTO groups (name) VALUES (?)", (name,))
        c.commit()
        return {"id": cur.lastrowid, "name": name}

def update_group(gid: int, name: str):
    with _conn() as c:
        c.execute("UPDATE groups SET name=? WHERE id=?", (name, gid))
        c.commit()

def delete_group(gid: int):
    with _conn() as c:
        # Move servers to General (id=1 usually, but let's find it)
        gen = c.execute("SELECT id FROM groups WHERE name='General'").fetchone()
        gen_id = gen['id'] if gen else 1
        c.execute("UPDATE servers SET group_id=? WHERE group_id=?", (gen_id, gid))
        c.execute("DELETE FROM groups WHERE id=? AND name != 'General'", (gid,))
        c.commit()

# ------------------------------------------------------------------
# Server CRUD (Updated)
# ------------------------------------------------------------------
def get_all_servers():
    with _conn() as c:
        # Join with groups to get the name
        rows = c.execute("""
            SELECT s.*, g.name as group_name 
            FROM servers s
            LEFT JOIN groups g ON s.group_id = g.id
            ORDER BY g.position, s.position, s.alias
        """).fetchall()
    return [dict(r) for r in rows]

def get_server(server_id: int):
    with _conn() as c:
        row = c.execute("SELECT * FROM servers WHERE id=?", (server_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["password"] = decrypt_password(d.pop("password_enc"))
    return d

def add_server(alias: str, ip: str, username: str, password: str, group_id: int = None, tags: str = '') -> dict:
    enc = encrypt_password(password)
    with _conn() as c:
        if group_id is None:
            gen = c.execute("SELECT id FROM groups WHERE name='General'").fetchone()
            group_id = gen['id'] if gen else 1
            
        cur = c.execute(
            "INSERT INTO servers (alias, ip, username, password_enc, group_id, tags) VALUES (?,?,?,?,?,?)",
            (alias, ip, username, enc, group_id, tags)
        )
        c.commit()
        return {"id": cur.lastrowid, "alias": alias, "ip": ip, "group_id": group_id, "tags": tags}

def update_server(server_id: int, **kwargs) -> bool:
    """Dynamic update to handle tags, group_id, etc."""
    with _conn() as c:
        if 'password' in kwargs:
            kwargs['password_enc'] = encrypt_password(kwargs.pop('password'))
            
        sets = []
        vals = []
        for k, v in kwargs.items():
            sets.append(f"{k}=?")
            vals.append(v)
        
        vals.append(server_id)
        c.execute(f"UPDATE servers SET {', '.join(sets)} WHERE id=?", tuple(vals))
        c.commit()
        return c.total_changes > 0

def move_server(server_id: int, new_group_id: int, new_position: int = 0):
    with _conn() as c:
        c.execute("UPDATE servers SET group_id=?, position=? WHERE id=?", (new_group_id, new_position, server_id))
        c.commit()

def delete_server(server_id: int) -> bool:
    with _conn() as c:
        c.execute("DELETE FROM servers WHERE id=?", (server_id,))
        c.commit()
        return c.total_changes > 0
