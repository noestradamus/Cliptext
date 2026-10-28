package life.cliptext.save;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

/** HTTPS only. A pinned leaf certificate is required before transmitting a token. */
public final class LocalApi {
    public static final class HttpFailure extends Exception {
        public final int status;
        public final boolean resetRequired;
        HttpFailure(int status, boolean resetRequired) { super(status == 401 ? "Pair this phone again from your Mac." : status == 403 ? "The Mac did not accept this address." : "The Mac could not complete this request."); this.status = status; this.resetRequired = resetRequired; }
    }
    public static final class Cancellation {
        private volatile boolean cancelled;
        private volatile HttpsURLConnection connection;
        public boolean cancelled() { return cancelled || Thread.currentThread().isInterrupted(); }
        public synchronized void attach(HttpsURLConnection value) throws InterruptedException {
            if (cancelled()) { value.disconnect(); throw new InterruptedException(); } connection = value;
        }
        public synchronized void detach(HttpsURLConnection value) { if (connection == value) connection = null; }
        public synchronized void cancel() { cancelled = true; if (connection != null) connection.disconnect(); }
    }
    private LocalApi() { }
    public static JSONObject request(LocalConnection saved, String path, JSONObject payload, Cancellation cancellation) throws Exception {
        if (!path.startsWith("/api/phone/") || path.contains("#") || path.length() > 2048) throw new IllegalArgumentException("Invalid sync action");
        Exception last = null;
        for (String endpoint : saved.endpoints) {
            if (cancellation.cancelled()) throw new InterruptedException();
            try { return requestAt(saved, endpoint, path, payload, cancellation); }
            catch (HttpFailure failure) { if (failure.status == 403) last = failure; else throw failure; }
            catch (Exception unavailable) { last = unavailable; }
        }
        if (last != null) throw last;
        throw new IllegalStateException("No Mac address configured");
    }
    private static JSONObject requestAt(final LocalConnection saved, String endpoint, String path, JSONObject payload, Cancellation cancellation) throws Exception {
        if (!LocalConnection.validEndpoint(endpoint)) throw new IllegalArgumentException("Invalid Mac address");
        HttpsURLConnection connection = (HttpsURLConnection) new URL(endpoint + path).openConnection(java.net.Proxy.NO_PROXY);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{new X509TrustManager() {
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            @Override public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client certificates are not accepted"); }
            @Override public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("Missing Mac certificate");
                CertificatePins.verify(chain[0], saved.fingerprint);
            }
        }}, new SecureRandom());
        connection.setSSLSocketFactory(tls.getSocketFactory());
        // The exact certificate, rather than an unstable LAN IP/DNS name, is the identity.
        connection.setHostnameVerifier((host, session) -> {
            try { CertificatePins.verify((X509Certificate) session.getPeerCertificates()[0], saved.fingerprint); return true; }
            catch (Exception invalid) { return false; }
        });
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(3500); connection.setReadTimeout(15000);
        connection.setUseCaches(false); connection.setRequestMethod(payload == null ? "GET" : "POST");
        connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Authorization", "Bearer " + saved.token);
        cancellation.attach(connection);
        try {
            if (payload != null) {
                byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
                if (data.length > 8192) throw new IllegalArgumentException("Request is too large");
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(data.length);
                try (OutputStream stream = connection.getOutputStream()) { stream.write(data); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                boolean reset = false;
                if (status == 409) {
                    try (InputStream stream = connection.getErrorStream()) {
                        ByteArrayOutputStream error = new ByteArrayOutputStream(); byte[] buffer = new byte[1024]; int count;
                        if (stream != null) while ((count = stream.read(buffer)) >= 0) { if (error.size() + count > 8192) break; error.write(buffer, 0, count); }
                        reset = new JSONObject(new String(error.toByteArray(), StandardCharsets.UTF_8)).optBoolean("resetRequired", false);
                    } catch (Exception ignored) { }
                }
                throw new HttpFailure(status, reset);
            }
            if (cancellation.cancelled()) throw new InterruptedException();
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) throw new IllegalStateException("Invalid Mac response");
            int declared = connection.getContentLength();
            if (declared > 32 * 1024 * 1024) throw new IllegalStateException("Sync page is too large");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream stream = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = stream.read(buffer)) >= 0) {
                    if (cancellation.cancelled()) throw new InterruptedException();
                    if (bytes.size() + count > 32 * 1024 * 1024) throw new IllegalStateException("Sync page is too large");
                    bytes.write(buffer, 0, count);
                }
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } finally { cancellation.detach(connection); connection.disconnect(); }
    }
}
