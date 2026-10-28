package life.cliptext.save;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Separate namespace deliberately ignores every previous hosted-Site credential. */
public final class LocalDeviceStore {
    private static final String KEY_ALIAS = "cliptext-local-mac-aes-v1";
    private static final byte[] AAD = "cliptext-local-mac-v1".getBytes(StandardCharsets.UTF_8);
    private final SharedPreferences preferences;
    public LocalDeviceStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences("encrypted-local-mac", Context.MODE_PRIVATE);
        // Retire obsolete cloud capabilities without touching the durable link queue.
        if (!preferences.getBoolean("legacyRetired", false)) {
            boolean retired = context.getApplicationContext().getSharedPreferences("encrypted-device-pairing", Context.MODE_PRIVATE).edit().clear().commit();
            retired &= context.getApplicationContext().getSharedPreferences("completion-alerts", Context.MODE_PRIVATE).edit().clear().commit();
            retired &= context.getApplicationContext().getSharedPreferences("connection-state", Context.MODE_PRIVATE).edit().clear().commit();
            if (retired) preferences.edit().putBoolean("legacyRetired", true).commit();
        }
    }
    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }
    public synchronized void save(LocalConnection connection) throws Exception {
        byte[] plaintext = connection.toJson().toString().getBytes(StandardCharsets.UTF_8);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(AAD);
            JSONObject envelope = new JSONObject(); envelope.put("v", 1); envelope.put("iv", Base64.getEncoder().encodeToString(cipher.getIV()));
            envelope.put("ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(plaintext)));
            if (!preferences.edit().putString("connection", envelope.toString()).remove("revoked").commit()) throw new IllegalStateException("Could not save connection");
        } finally { Arrays.fill(plaintext, (byte) 0); }
    }
    public synchronized LocalConnection load() throws Exception {
        String saved = preferences.getString("connection", null); if (saved == null) return null;
        if (saved.length() > 24000) throw new IllegalArgumentException("Invalid saved connection");
        JSONObject envelope = new JSONObject(saved);
        if (envelope.getInt("v") != 1) throw new IllegalArgumentException("Invalid saved connection");
        byte[] iv = Base64.getDecoder().decode(envelope.getString("iv"));
        if (iv.length != 12) throw new IllegalArgumentException("Invalid saved connection");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv)); cipher.updateAAD(AAD);
        byte[] plaintext = cipher.doFinal(Base64.getDecoder().decode(envelope.getString("ciphertext")));
        try { return LocalConnection.fromJson(new JSONObject(new String(plaintext, StandardCharsets.UTF_8))); }
        finally { Arrays.fill(plaintext, (byte) 0); }
    }
    public void setRevoked() { preferences.edit().putBoolean("revoked", true).commit(); }
    public boolean revoked() { return preferences.getBoolean("revoked", false); }
    public void disconnect() { preferences.edit().clear().commit(); }
}
