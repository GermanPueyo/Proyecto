"""
database.py — PostgreSQL persistence and encryption for WinRM servers
Integrated with python-dotenv for secure credential management.
"""
import psycopg2
import psycopg2.extras
import os
from dotenv import load_dotenv
from cryptography.fernet import Fernet
import datetime
import psycopg2.pool

# Load credentials
load_dotenv()

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.path.join(_BASE_DIR, "data")
_KEY_FILE = os.path.join(_DATA_DIR, ".fernet.key")

# Ensure data directory exists for the key
if not os.path.exists(_DATA_DIR):
    os.makedirs(_DATA_DIR)

# ------------------------------------------------------------------
# Fernet key management (Kept from SQLite version)
# ------------------------------------------------------------------
def _get_fernet():
    if os.path.isfile(_KEY_FILE):
        with open(_KEY_FILE, "rb") as f:
            key = f.read().strip()
    else:
        key = Fernet.generate_key()
        with open(_KEY_FILE, "wb") as f:
            f.write(key)
        try: os.chmod(_KEY_FILE, 0o600)
        except: pass
    return Fernet(key)

_fernet = _get_fernet()

def encrypt_password(plain: str) -> str:
    return _fernet.encrypt(plain.encode("utf-8")).decode("utf-8")

def decrypt_password(cipher: str) -> str:
    return _fernet.decrypt(cipher.encode("utf-8")).decode("utf-8")

# ------------------------------------------------------------------
# Database connection pooling
# ------------------------------------------------------------------
_db_pool = None

def _get_pool():
    global _db_pool
    if _db_pool is None:
        _db_pool = psycopg2.pool.ThreadedConnectionPool(
            1, 20, # Min/Max connections
            host=os.getenv("PG_HOST", "localhost"),
            port=os.getenv("PG_PORT", "5432"),
            user=os.getenv("PG_USER", "postgres"),
            password=os.getenv("PG_PASS", ""),
            dbname=os.getenv("PG_DB", "winrm_monitor")
        )
    return _db_pool

from contextlib import contextmanager

@contextmanager
def _conn():
    """Acquires a connection from the pool and releases it back when done."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        yield conn
    finally:
        pool.putconn(conn)

def init_db():
    """Initializes the PostgreSQL database schema."""
    with _conn() as conn:
        with conn.cursor() as c:
            # 1. Groups table
            c.execute("""
                CREATE TABLE IF NOT EXISTS groups (
                    id       SERIAL PRIMARY KEY,
                    name     TEXT NOT NULL UNIQUE,
                    position INTEGER NOT NULL DEFAULT 0
                )
            """)
            
            # 2. Servers table
            c.execute("""
                CREATE TABLE IF NOT EXISTS servers (
                    id           SERIAL PRIMARY KEY,
                    alias        TEXT NOT NULL UNIQUE,
                    ip           TEXT NOT NULL UNIQUE,
                    username     TEXT NOT NULL,
                    password_enc TEXT NOT NULL,
                    group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
                    tags         TEXT DEFAULT '',
                    position     INTEGER NOT NULL DEFAULT 0,
                    is_agent     BOOLEAN NOT NULL DEFAULT FALSE,
                    status       TEXT DEFAULT 'offline',
                    last_seen    TIMESTAMP
                )
            """)

            # 3. Alerts log table
            c.execute("""
                CREATE TABLE IF NOT EXISTS alerts_log (
                    id            SERIAL PRIMARY KEY,
                    server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    timestamp     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    end_timestamp TIMESTAMP,
                    metric_type   TEXT NOT NULL,
                    value         REAL,
                    value_avg     REAL,
                    value_sum     REAL DEFAULT 0,
                    sample_count  INTEGER DEFAULT 0,
                    is_active     BOOLEAN DEFAULT TRUE
                )
            """)

            # Ensure 'General' group exists
            c.execute("INSERT INTO groups (name) VALUES ('General') ON CONFLICT (name) DO NOTHING")
            
            # --- PERFORMANCE INDICES ---
            c.execute("CREATE INDEX IF NOT EXISTS idx_alerts_log_server_id_active ON alerts_log(server_id) WHERE is_active = TRUE")
            c.execute("CREATE INDEX IF NOT EXISTS idx_servers_ip ON servers(ip)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_servers_alias ON servers(alias)")
            
            conn.commit()

# Run initialization
init_db()

# ------------------------------------------------------------------
# Group CRUD
# ------------------------------------------------------------------
def get_all_groups():
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("SELECT * FROM groups ORDER BY position, name")
            return [dict(r) for r in c.fetchall()]

def add_group(name: str):
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("INSERT INTO groups (name) VALUES (%s) RETURNING id", (name,))
            conn.commit()
            return {"id": c.fetchone()['id'], "name": name}

def update_group(gid: int, name: str):
    with _conn() as conn:
        with conn.cursor() as c:
            c.execute("UPDATE groups SET name=%s WHERE id=%s", (name, gid))
            conn.commit()

def delete_group(gid: int):
    with _conn() as conn:
        with conn.cursor() as c:
            # Find General group ID
            c.execute("SELECT id FROM groups WHERE name='General'")
            gen_id = c.fetchone()[0]
            # Move servers to General
            c.execute("UPDATE servers SET group_id=%s WHERE group_id=%s", (gen_id, gid))
            # Delete group (except General)
            c.execute("DELETE FROM groups WHERE id=%s AND name != 'General'", (gid,))
            conn.commit()

# ------------------------------------------------------------------
# Server CRUD
# ------------------------------------------------------------------
def get_all_servers():
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT s.*, g.name as group_name 
                FROM servers s
                LEFT JOIN groups g ON s.group_id = g.id
                ORDER BY g.position, s.position, s.alias
            """)
            return [dict(r) for r in c.fetchall()]

def get_server(server_id: int):
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("SELECT * FROM servers WHERE id=%s", (server_id,))
            row = c.fetchone()
    if not row:
        return None
    d = dict(row)
    d["password"] = decrypt_password(d.pop("password_enc"))
    return d

def add_server(alias: str, ip: str, username: str, password: str, group_id: int = None, tags: str = '') -> dict:
    enc = encrypt_password(password)
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            if group_id is None:
                c.execute("SELECT id FROM groups WHERE name='General'")
                group_id = c.fetchone()['id']
                
            c.execute(
                "INSERT INTO servers (alias, ip, username, password_enc, group_id, tags) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (alias, ip, username, enc, group_id, tags)
            )
            conn.commit()
            return {"id": c.fetchone()['id'], "alias": alias, "ip": ip, "group_id": group_id, "tags": tags}

def update_server(server_id: int, **kwargs) -> bool:
    with _conn() as conn:
        with conn.cursor() as c:
            if 'password' in kwargs:
                kwargs['password_enc'] = encrypt_password(kwargs.pop('password'))
                
            sets = []
            vals = []
            for k, v in kwargs.items():
                sets.append(f"{k}=%s")
                vals.append(v)
            
            vals.append(server_id)
            c.execute(f"UPDATE servers SET {', '.join(sets)} WHERE id=%s", tuple(vals))
            conn.commit()
            return c.rowcount > 0

def move_server(server_id: int, new_group_id: int, new_position: int = 0):
    with _conn() as conn:
        with conn.cursor() as c:
            c.execute("UPDATE servers SET group_id=%s, position=%s WHERE id=%s", (new_group_id, new_position, server_id))
            conn.commit()

def delete_server(server_id: int) -> bool:
    with _conn() as conn:
        with conn.cursor() as c:
            c.execute("DELETE FROM servers WHERE id=%s", (server_id,))
            conn.commit()
            return c.rowcount > 0

# ------------------------------------------------------------------
# Alerts Log
# ------------------------------------------------------------------
def add_alert_log(server_id: int, metric_type: str, value: float):
    """Starts a new alert or updates statistics."""
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT id, value, value_sum, sample_count FROM alerts_log 
                WHERE server_id = %s AND metric_type = %s AND is_active = TRUE
            """, (server_id, metric_type))
            active = c.fetchone()
            
            if not active:
                c.execute(
                    "INSERT INTO alerts_log (server_id, metric_type, value, value_sum, sample_count) VALUES (%s,%s,%s,%s,1)",
                    (server_id, metric_type, value, value)
                )
            else:
                new_peak = max(value, active['value'])
                new_sum = active['value_sum'] + value
                new_count = active['sample_count'] + 1
                c.execute("""
                    UPDATE alerts_log 
                    SET value = %s, value_sum = %s, sample_count = %s 
                    WHERE id = %s
                """, (new_peak, new_sum, new_count, active['id']))
            conn.commit()

def resolve_alert_log(server_id: int, metric_type: str):
    """Closes alert and calculates the final average."""
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT id, value_sum, sample_count FROM alerts_log 
                WHERE server_id = %s AND metric_type = %s AND is_active = TRUE
            """, (server_id, metric_type))
            active = c.fetchone()
            
            if active and active['sample_count'] > 0:
                final_avg = active['value_sum'] / active['sample_count']
                c.execute("""
                    UPDATE alerts_log 
                    SET end_timestamp = CURRENT_TIMESTAMP, is_active = FALSE, value_avg = %s 
                    WHERE id = %s
                """, (final_avg, active['id']))
            conn.commit()

def get_alert_logs(limit=100):
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT l.*, s.alias as server_name 
                FROM alerts_log l
                JOIN servers s ON l.server_id = s.id
                ORDER BY l.timestamp DESC
                LIMIT %s
            """, (limit,))
            return [dict(r) for r in c.fetchall()]

def delete_alert_log(log_id: int):
    with _conn() as conn:
        with conn.cursor() as c:
            c.execute("DELETE FROM alerts_log WHERE id = %s", (log_id,))
            conn.commit()

def clear_all_logs():
    with _conn() as conn:
        with conn.cursor() as c:
            c.execute("DELETE FROM alerts_log")
            conn.commit()

def purge_old_logs():
    """Deletes logs older than 24 hours (keeping only the last day)."""
    with _conn() as conn:
        with conn.cursor() as c:
            # Delete logs where the timestamp is older than 1 day
            c.execute("DELETE FROM alerts_log WHERE timestamp < NOW() - INTERVAL '1 day'")
            conn.commit()
            return c.rowcount
