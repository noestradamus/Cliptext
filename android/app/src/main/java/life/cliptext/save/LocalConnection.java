package life.cliptext.save;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** The Mac's certificate is the trust anchor; addresses never establish trust. */
public final class LocalConnection {
    public final String[] endpoints;
    public final String fingerprint, deviceId, token;
    public LocalConnection(String[] endpoints, String fingerprint, String deviceId, String token) {
        if (endpoints == null || endpoints.length < 1 || endpoints.length > 12) throw new IllegalArgumentException("Invalid Mac addresses");
        HashSet<String> unique = new HashSet<>();
        for (String endpoint : endpoints) {
            if (!validEndpoint(endpoint) || !unique.add(endpoint)) throw new IllegalArgumentException("Invalid Mac address");
        }
        if (fingerprint == null || !fingerprint.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid Mac certificate");
        if (deviceId == null || !deviceId.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException("Invalid device identifier");
        if (token == null || !token.matches("[A-Za-z0-9_-]{32,256}")) throw new IllegalArgumentException("Invalid pairing token");
        this.endpoints = endpoints.clone(); this.fingerprint = fingerprint; this.deviceId = deviceId; this.token = token;
    }
    public static boolean validEndpoint(String endpoint) {
        if (endpoint == null || endpoint.length() > 512 || !endpoint.equals(endpoint.trim())) return false;
        try {
            URI uri = new URI(endpoint);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && !uri.getHost().isEmpty()
                && uri.getUserInfo() == null && uri.getQuery() == null && uri.getFragment() == null
                && (uri.getRawPath().isEmpty()) && uri.getPort() > 0 && uri.getPort() <= 65535;
        } catch (Exception invalid) { return false; }
    }
    public static LocalConnection parseCode(String code) throws Exception {
        if (code == null || code.length() > 8192) throw new IllegalArgumentException("Invalid pairing code");
        String compact = code.trim();
        if (!compact.matches("[A-Za-z0-9_-]+={0,2}")) throw new IllegalArgumentException("Copy the pairing code from your Mac");
        byte[] decoded = Base64.getUrlDecoder().decode(compact);
        if (decoded.length > 12288) throw new IllegalArgumentException("Pairing code is too large");
        return fromJson(new JSONObject(new String(decoded, StandardCharsets.UTF_8)));
    }
    public static LocalConnection fromJson(JSONObject json) throws Exception {
        if (json.getInt("v") != 1) throw new IllegalArgumentException("Unsupported pairing version");
        JSONArray addresses = json.getJSONArray("endpoints");
        if (addresses.length() < 1 || addresses.length() > 12) throw new IllegalArgumentException("Invalid Mac addresses");
        String[] endpoints = new String[addresses.length()];
        for (int i = 0; i < endpoints.length; i++) endpoints[i] = addresses.getString(i);
        return new LocalConnection(endpoints, json.getString("fingerprint"), json.getString("deviceId"), json.getString("token"));
    }
    public JSONObject toJson() throws Exception {
        JSONObject json = new JSONObject(); json.put("v", 1); json.put("endpoints", new JSONArray(endpoints));
        json.put("fingerprint", fingerprint); json.put("deviceId", deviceId); json.put("token", token); return json;
    }
    public LocalConnection withEndpoints(String text) {
        if (text == null || text.trim().isEmpty()) throw new IllegalArgumentException("Enter your Mac address");
        return new LocalConnection(text.trim().split("\\s+"), fingerprint, deviceId, token);
    }
}
