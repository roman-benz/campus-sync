// Geheimnisse wie Electrons safeStorage unter Windows: AES-256-GCM mit einem Schlüssel, der per
// DPAPI geschützt in „Local State“ liegt (Format „v10“ + Nonce + Chiffrat + Tag). So lesen die
// Electron- und die Tauri-Version dieselbe secrets.json – ein Umstieg (und zurück) behält die Anmeldung.
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

pub struct Secrets {
    local_state: PathBuf,
    key: Mutex<Option<[u8; 32]>>,
}

fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        let res = if protect {
            CryptProtectData(&input, None, None, None, None, 0, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
        };
        res.map_err(|e| format!("DPAPI: {e}"))?;
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Ok(bytes)
    }
}

impl Secrets {
    pub fn new(user_data: &Path) -> Self {
        Secrets { local_state: user_data.join("Local State"), key: Mutex::new(None) }
    }

    fn read_state(&self) -> serde_json::Value {
        std::fs::read_to_string(&self.local_state)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    }

    // Schlüssel aus „Local State“ (wie Chromium/Electron) – fehlt er, wird ein neuer angelegt
    fn key(&self) -> Result<[u8; 32], String> {
        let mut guard = self.key.lock().unwrap();
        if let Some(k) = *guard {
            return Ok(k);
        }
        let mut state = self.read_state();
        if let Some(enc) = state.pointer("/os_crypt/encrypted_key").and_then(|v| v.as_str()) {
            let raw = B64.decode(enc).map_err(|e| e.to_string())?;
            let blob = raw.strip_prefix(b"DPAPI").ok_or("Local State: unbekanntes Schlüsselformat")?;
            let plain = dpapi(blob, false)?;
            let key: [u8; 32] = plain.as_slice().try_into().map_err(|_| "Local State: Schlüssellänge")?;
            *guard = Some(key);
            return Ok(key);
        }
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let mut blob = b"DPAPI".to_vec();
        blob.extend(dpapi(&key, true)?);
        if !state.is_object() {
            state = serde_json::json!({});
        }
        let obj = state.as_object_mut().unwrap();
        let os = obj.entry("os_crypt").or_insert_with(|| serde_json::json!({}));
        os["encrypted_key"] = serde_json::Value::String(B64.encode(blob));
        if let Some(dir) = self.local_state.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&self.local_state, serde_json::to_vec(&state).unwrap()).map_err(|e| e.to_string())?;
        *guard = Some(key);
        Ok(key)
    }

    pub fn encrypt(&self, text: &str) -> Result<Vec<u8>, String> {
        let key = self.key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), text.as_bytes()).map_err(|e| e.to_string())?;
        let mut out = b"v10".to_vec();
        out.extend_from_slice(&nonce);
        out.extend(ct);
        Ok(out)
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<String, String> {
        let plain = if let Some(rest) = data.strip_prefix(b"v10") {
            if rest.len() < 12 + 16 {
                return Err("Chiffrat zu kurz".into());
            }
            let key = self.key()?;
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
            cipher.decrypt(Nonce::from_slice(&rest[..12]), &rest[12..]).map_err(|_| "Entschlüsseln fehlgeschlagen".to_string())?
        } else {
            // Sehr alte Electron-Versionen: reiner DPAPI-Blob
            dpapi(data, false)?
        };
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
}
