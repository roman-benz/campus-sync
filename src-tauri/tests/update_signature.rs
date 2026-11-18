// Prüft, ob die Update-Signatur des gebauten Installers zum öffentlichen Schlüssel in
// tauri.conf.json passt – so wie es der Updater der installierten App tut.
// INSTALLER=<…-setup.exe> cargo test --test update_signature -- --ignored
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn b64(s: &str) -> String {
    String::from_utf8(STANDARD.decode(s.trim()).expect("base64")).expect("utf8")
}

#[test]
#[ignore]
fn installer_signature_matches_pubkey() {
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let installer = std::env::var("INSTALLER").expect("INSTALLER");
    let data = std::fs::read(&installer).unwrap();
    let sig = std::fs::read_to_string(format!("{installer}.sig")).unwrap();
    let pk = PublicKey::decode(&b64(pubkey)).expect("öffentlicher Schlüssel");
    let signature = Signature::decode(&b64(&sig)).expect("Signatur");
    pk.verify(&data, &signature, true).expect("Signatur passt nicht zum Schlüssel");
    // Manipulierte Datei muss scheitern
    let mut bad = data.clone();
    bad[1000] ^= 1;
    assert!(pk.verify(&bad, &signature, true).is_err());
}
