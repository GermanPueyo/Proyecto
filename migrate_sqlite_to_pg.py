import sqlite3
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()

SQLITE_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "servers.db")

def migrate():
    if not os.path.exists(SQLITE_DB):
        print("No se encontró base de datos SQLite para migrar.")
        return

    print("--- Iniciando migración de datos (SQLite -> PostgreSQL) ---")
    
    try:
        sl_conn = sqlite3.connect(SQLITE_DB)
        sl_conn.row_factory = sqlite3.Row
        sl_cur = sl_conn.cursor()

        pg_conn = psycopg2.connect(
            host=os.getenv("PG_HOST"),
            port=os.getenv("PG_PORT"),
            user=os.getenv("PG_USER"),
            password=os.getenv("PG_PASS"),
            dbname=os.getenv("PG_DB")
        )
        pg_cur = pg_conn.cursor()

        # 1. Migrar GRUPOS (Evitando duplicar 'General' que ya se crea en init_db)
        print("Migrando grupos...")
        sl_cur.execute("SELECT * FROM groups")
        groups = sl_cur.fetchall()
        for g in groups:
            pg_cur.execute(
                "INSERT INTO groups (id, name, position) VALUES (%s, %s, %s) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, position=EXCLUDED.position",
                (g['id'], g['name'], g['position'])
            )
        
        # Sincronizar secuencia de IDs para PostgreSQL
        pg_cur.execute("SELECT setval(pg_get_serial_sequence('groups', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM groups")

        # 2. Migrar SERVIDORES
        print("Migrando servidores...")
        sl_cur.execute("SELECT * FROM servers")
        servers = sl_cur.fetchall()
        for s in servers:
            pg_cur.execute("""
                INSERT INTO servers (id, alias, ip, username, password_enc, group_id, tags, position, is_agent, status, last_seen)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (
                s['id'], s['alias'], s['ip'], s['username'], s['password_enc'], 
                s['group_id'], s['tags'], s['position'], bool(s['is_agent']), 
                s['status'], s['last_seen']
            ))
        
        pg_cur.execute("SELECT setval(pg_get_serial_sequence('servers', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM servers")

        # 3. Migrar LOGS
        print("Migrando logs de alertas...")
        sl_cur.execute("SELECT * FROM alerts_log")
        logs = sl_cur.fetchall()
        for l in logs:
            pg_cur.execute("""
                INSERT INTO alerts_log (id, server_id, timestamp, end_timestamp, metric_type, value, value_avg, value_sum, sample_count, is_active)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (
                l['id'], l['server_id'], l['timestamp'], l['end_timestamp'], 
                l['metric_type'], l['value'], l['value_avg'], l['value_sum'], 
                l['sample_count'], bool(l['is_active'])
            ))

        pg_cur.execute("SELECT setval(pg_get_serial_sequence('alerts_log', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM alerts_log")

        pg_conn.commit()
        print("✅ Migración completada con éxito.")

    except Exception as e:
        print(f"❌ Error durante la migración: {e}")
    finally:
        sl_conn.close()
        pg_conn.close()

if __name__ == "__main__":
    migrate()
