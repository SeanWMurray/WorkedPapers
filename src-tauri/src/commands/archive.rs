use crate::error::{AppError, Result};
use crate::AppState;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use rand::RngCore;
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use tauri::State;
use zip::{write::FileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAGIC: &[u8] = b"WWP1"; // file format magic bytes

/// Export the currently open engagement directory as an encrypted .wwp archive.
#[tauri::command]
pub async fn export_wwp(
    output_path: String,
    password: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let db_path = {
        let guard = state.db.lock().unwrap();
        let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
        db.path.clone()
    };

    let db_dir = Path::new(&db_path)
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine engagement directory".into()))?;

    // Build zip in memory
    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_buf);
        let mut zip = ZipWriter::new(cursor);
        let opts = FileOptions::<()>::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6));

        add_dir_to_zip(&mut zip, db_dir, db_dir, &opts)?;
        zip.finish().map_err(|e| AppError::Other(e.to_string()))?;
    }

    // Derive a 256-bit key from the password (PBKDF2-SHA256, 100k iterations)
    let key_bytes = derive_key(password.as_bytes());
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce_bytes, zip_buf.as_slice())
        .map_err(|e| AppError::Encryption(e.to_string()))?;

    // Write: MAGIC (4) + nonce (12) + ciphertext
    let mut out = fs::File::create(&output_path)?;
    out.write_all(MAGIC)?;
    out.write_all(&nonce_bytes)?;
    out.write_all(&ciphertext)?;

    Ok(())
}

/// Decrypt and extract a .wwp archive to a target directory.
#[tauri::command]
pub async fn import_wwp(
    wwp_path: String,
    target_dir: String,
    password: String,
) -> std::result::Result<String, AppError> {
    let mut raw = fs::read(&wwp_path)?;

    if raw.len() < MAGIC.len() + 12 {
        return Err(AppError::Other("Not a valid .wwp file".into()));
    }
    if &raw[..4] != MAGIC {
        return Err(AppError::Other("Invalid .wwp magic bytes".into()));
    }

    let nonce_bytes = &raw[4..16];
    let ciphertext = &raw[16..];

    let key_bytes = derive_key(password.as_bytes());
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);

    let zip_buf = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Encryption("Decryption failed — wrong password?".into()))?;

    let cursor = std::io::Cursor::new(zip_buf);
    let mut archive = ZipArchive::new(cursor).map_err(|e| AppError::Other(e.to_string()))?;

    fs::create_dir_all(&target_dir)?;
    archive
        .extract(&target_dir)
        .map_err(|e| AppError::Other(e.to_string()))?;

    // Return the path to the first .db file found
    let db_file = fs::read_dir(&target_dir)?
        .filter_map(|e| e.ok())
        .find(|e| e.path().extension().map_or(false, |x| x == "db"))
        .map(|e| e.path().to_string_lossy().into_owned())
        .unwrap_or(target_dir.clone());

    Ok(db_file)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    base: &Path,
    dir: &Path,
    opts: &FileOptions<()>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.strip_prefix(base).unwrap().to_string_lossy();

        if path.is_dir() {
            zip.add_directory(format!("{name}/"), *opts)
                .map_err(|e| AppError::Other(e.to_string()))?;
            add_dir_to_zip(zip, base, &path, opts)?;
        } else {
            zip.start_file(name.to_string(), *opts)
                .map_err(|e| AppError::Other(e.to_string()))?;
            let mut f = fs::File::open(&path)?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            zip.write_all(&buf)?;
        }
    }
    Ok(())
}

fn derive_key(password: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    // Simple PBKDF2-like: 100k rounds of SHA-256 with a fixed salt.
    // For production quality, swap this for ring::pbkdf2 or argon2.
    let salt = b"workedpapers-salt-v1";
    let mut key = [0u8; 32];
    let mut input = [password, salt].concat();
    for _ in 0..100_000 {
        let hash = Sha256::digest(&input);
        key.copy_from_slice(&hash);
        input = hash.to_vec();
    }
    key
}
