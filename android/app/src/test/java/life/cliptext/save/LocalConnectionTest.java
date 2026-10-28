package life.cliptext.save;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

public class LocalConnectionTest {
    private static LocalConnection connection() { return new LocalConnection(new String[]{"https://192.168.1.5:47322", "https://100.100.1.5:47322"}, repeat("a", 64), "sample-device", repeat("t", 43)); }
    private static String repeat(String value, int length) { StringBuilder out = new StringBuilder(); while (out.length() < length) out.append(value); return out.toString(); }
    @Test public void roundTrip() throws Exception { LocalConnection old = connection(); String code = Base64.getUrlEncoder().withoutPadding().encodeToString(old.toJson().toString().getBytes(StandardCharsets.UTF_8)); LocalConnection parsed = LocalConnection.parseCode(code); assertEquals(old.token, parsed.token); assertArrayEquals(old.endpoints, parsed.endpoints); assertEquals(old.fingerprint, parsed.fingerprint); }
    @Test public void rejectsCleartextAndUrlConfusion() { for (String endpoint : new String[]{"http://192.168.1.5:47322", "https://user@192.168.1.5:47322", "https://192.168.1.5:47322/path", "https://192.168.1.5:47322?token=x", "https://192.168.1.5:47322#x", "https://192.168.1.5", "https://192.168.1.5:0", "https://192.168.1.5:99999", " https://192.168.1.5:47322", "https://192.168.1.5:47322/", "https:////192.168.1.5:47322"}) assertFalse(endpoint, LocalConnection.validEndpoint(endpoint)); }
    @Test public void acceptsStableNamesAndVpn() { assertTrue(LocalConnection.validEndpoint("https://mac.local:47322")); assertTrue(LocalConnection.validEndpoint("https://mac.example.ts.net:47322")); assertTrue(LocalConnection.validEndpoint("https://100.80.90.100:47322")); }
    @Test public void addressUpdateKeepsIdentity() { LocalConnection old = connection(), updated = old.withEndpoints("https://mac.local:47322\nhttps://100.80.90.100:47322"); assertEquals(old.token, updated.token); assertEquals(old.fingerprint, updated.fingerprint); assertEquals(old.deviceId, updated.deviceId); }
    @Test public void refusesDuplicateAddresses() { try { connection().withEndpoints("https://mac.local:47322 https://mac.local:47322"); fail(); } catch (IllegalArgumentException expected) { } }
    @Test public void refusesHeaderInjection() { try { new LocalConnection(connection().endpoints, repeat("a", 64), "device", repeat("t", 43) + "\r\nBad: x"); fail(); } catch (IllegalArgumentException expected) { } }
    @Test public void refusesLargeAndMalformedCodes() throws Exception { for (String code : new String[]{repeat("a", 8193), "", "not a code", "https://example.test", "e30"}) { try { LocalConnection.parseCode(code); fail(code); } catch (Exception expected) { } } }
    @Test public void rejectsUnsupportedVersion() throws Exception { JSONObject payload = connection().toJson(); payload.put("v", 2); try { LocalConnection.fromJson(payload); fail(); } catch (IllegalArgumentException expected) { } }
    @Test public void rejectsMissingPinAndToken() throws Exception { for (String key : new String[]{"token", "fingerprint", "deviceId", "endpoints"}) { JSONObject payload = connection().toJson(); payload.remove(key); try { LocalConnection.fromJson(payload); fail(key); } catch (Exception expected) { } } }
    @Test public void endpointsAreDefensivelyCopied() { String[] addresses = {"https://mac.local:47322"}; LocalConnection candidate = new LocalConnection(addresses, repeat("a", 64), "phone", repeat("b", 43)); addresses[0] = "http://evil.invalid"; assertEquals("https://mac.local:47322", candidate.endpoints[0]); }
}
