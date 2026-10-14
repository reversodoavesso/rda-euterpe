//! Cache KV com TTL — paridade com `getCache`/`setCache` do Node.

use rusqlite::Connection;

pub fn get_cache(conn: &Connection, key: &str) -> Option<String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?")
        .ok()?;
    let (value, expires_at): (String, Option<i64>) =
        stmt.query_row([key], |r| Ok((r.get(0)?, r.get(1)?))).ok()?;
    if let Some(exp) = expires_at {
        if exp < chrono::Utc::now().timestamp_millis() {
            return None;
        }
    }
    Some(value)
}

pub fn set_cache(conn: &Connection, key: &str, value: &str, ttl_ms: i64) {
    let expires = if ttl_ms > 0 {
        Some(chrono::Utc::now().timestamp_millis() + ttl_ms)
    } else {
        None
    };
    if let Err(err) = conn.execute(
        "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
        rusqlite::params![key, value, expires],
    ) {
        tracing::error!(error = %err, "falha ao gravar cache");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_expires() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                set_cache(c, "k", "v", 0);
                // Node: TTL <= 0 significa "sem expiração" (não "já expirado").
                set_cache(c, "never", "v", -1);
                set_cache(c, "alive", "v", 60_000);
                set_cache(c, "soon", "v", 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.with(|c| Ok(get_cache(c, "k"))).unwrap(),
            Some("v".into())
        );
        assert_eq!(
            store.with(|c| Ok(get_cache(c, "alive"))).unwrap(),
            Some("v".into())
        );
        assert_eq!(
            store.with(|c| Ok(get_cache(c, "never"))).unwrap(),
            Some("v".into())
        );
        assert_eq!(store.with(|c| Ok(get_cache(c, "missing"))).unwrap(), None);

        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            store.with(|c| Ok(get_cache(c, "soon"))).unwrap(),
            None,
            "TTL precisa expirar"
        );
    }

    #[test]
    fn expired_entries_can_be_replaced() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                set_cache(c, "key", "velho", 1);
                Ok(())
            })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(store.with(|c| Ok(get_cache(c, "key"))).unwrap(), None);
        store
            .with(|c| {
                set_cache(c, "key", "novo", 0);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.with(|c| Ok(get_cache(c, "key"))).unwrap(),
            Some("novo".into())
        );
    }
}
