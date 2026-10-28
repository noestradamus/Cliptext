import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Base64;
import org.json.JSONObject;
import life.cliptext.save.LocalConnection;
import life.cliptext.save.LocalApi;
import life.cliptext.save.SyncPage;

/** Desktop JVM protocol probe: input JSON via stdin; no token in argv or output. */
public final class LocalProtocolProbe {
    public static void main(String[] args) throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        JSONObject request = new JSONObject(input.readLine()); LocalConnection connection = LocalConnection.parseCode(request.getString("code"));
        String path = request.optString("path", "/api/phone/sync?cursor=0&limit=50");
        JSONObject payload = request.optJSONObject("payload");
        JSONObject response = LocalApi.request(connection, path, payload, new LocalApi.Cancellation());
        if (path.startsWith("/api/phone/sync?")) { SyncPage page = new SyncPage(response, request.optLong("previous", 0)); System.out.println(new JSONObject().put("cursor", page.cursor).put("count", page.changes.length()).put("hasMore", page.hasMore)); }
        else if (path.equals("/api/phone/pair")) {
            if (!connection.deviceId.equals(response.getString("deviceId"))) throw new IllegalStateException("Different device returned");
            String token = response.getString("token");
            if (token.equals(connection.token)) throw new IllegalStateException("Pairing did not exchange tokens");
            LocalConnection paired = new LocalConnection(connection.endpoints, connection.fingerprint, connection.deviceId, token);
            if (request.has("output")) {
                Path output = Paths.get(request.getString("output"));
                if (Files.exists(output)) throw new IllegalArgumentException("Output already exists");
                Files.createFile(output, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                String code = Base64.getUrlEncoder().withoutPadding().encodeToString(paired.toJson().toString().getBytes(StandardCharsets.UTF_8));
                Files.write(output, code.getBytes(StandardCharsets.UTF_8), StandardOpenOption.WRITE);
            }
            System.out.println(new JSONObject().put("paired", true).put("tokenExchanged", true));
        }
        else if (path.equals("/api/phone/links")) System.out.println(new JSONObject().put("jobId", response.getString("jobId")));
        else throw new IllegalArgumentException("Unsupported probe action");
    }
}
