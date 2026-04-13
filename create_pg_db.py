import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
import os
from dotenv import load_dotenv

load_dotenv()

def create_database():
    host = os.getenv("PG_HOST", "localhost")
    user = os.getenv("PG_USER", "postgres")
    password = os.getenv("PG_PASS", "")
    dbname = os.getenv("PG_DB", "winrm_monitor")

    print(f"Connecting to PostgreSQL at {host} as {user}...")
    
    try:
        # Connect to 'postgres' default database to create the new one
        conn = psycopg2.connect(
            host=host,
            user=user,
            password=password,
            dbname='postgres'
        )
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        
        # Check if DB exists
        cur.execute(f"SELECT 1 FROM pg_catalog.pg_database WHERE datname = '{dbname}'")
        exists = cur.fetchone()
        
        if not exists:
            print(f"Creating database '{dbname}'...")
            cur.execute(f"CREATE DATABASE {dbname}")
            print("Database created successfully.")
        else:
            print(f"Database '{dbname}' already exists.")
            
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Error creating database: {e}")
        print("Check if PostgreSQL is running and credentials are correct.")

if __name__ == "__main__":
    create_database()
