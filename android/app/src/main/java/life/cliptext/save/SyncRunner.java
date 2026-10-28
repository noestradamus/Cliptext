package life.cliptext.save;

import android.content.Context;
import org.json.JSONObject;

/** Shared by foreground and Android jobs; no overlapping uploads or cursor writers. */
public final class SyncRunner {
    private static final Object LOCK = new Object();
    private static volatile LocalApi.Cancellation running;
    private static volatile boolean disconnecting, changing;
    public enum Result { SYNCED, WAITING, UNPAIRED, MORE, CANCELLED }
    private SyncRunner() { }
    public static void pair(Context context, LocalConnection candidate, String name, LocalApi.Cancellation cancel) throws Exception {
        changing = true; stopCurrent();
        try {
            synchronized (LOCK) {
            if (cancel.cancelled() || disconnecting) throw new InterruptedException();
            running = cancel;
            JSONObject payload = new JSONObject(); payload.put("name", name == null || name.trim().isEmpty() ? "Android" : name.trim().substring(0, Math.min(80, name.trim().length())));
            JSONObject response = LocalApi.request(candidate, "/api/phone/pair", payload, cancel);
            if (cancel.cancelled() || disconnecting) throw new InterruptedException();
            if (!candidate.deviceId.equals(response.getString("deviceId"))) throw new IllegalStateException("The Mac returned a different device");
            String token = response.getString("token");
            if (token.equals(candidate.token)) throw new IllegalStateException("The Mac did not exchange the pairing capability");
            LocalConnection connected = new LocalConnection(candidate.endpoints, candidate.fingerprint, candidate.deviceId, token);
            new LocalDeviceStore(context).save(connected);
            try (LibraryStore library = new LibraryStore(context)) { library.ensureScope(candidate.fingerprint); library.state("Connected"); }
            try (QueueStore queue = new QueueStore(context)) { queue.retryAll(); }
        }
        } finally { if (running == cancel) running = null; changing = false; }
        SyncScheduler.ensurePeriodic(context); SyncScheduler.soon(context, 0);
    }
    public static Result run(Context context, LocalApi.Cancellation cancel, boolean manual) {
        synchronized (LOCK) {
            if (cancel.cancelled() || disconnecting || changing) return Result.CANCELLED;
            running = cancel;
            try {
            LocalDeviceStore devices = new LocalDeviceStore(context);
            try (LibraryStore library = new LibraryStore(context); QueueStore queue = new QueueStore(context)) {
                LocalConnection connection = devices.load();
                if (connection == null || devices.revoked()) { library.state("Pair your Mac"); return Result.UNPAIRED; }
                library.ensureScope(connection.fingerprint);
                // Periodic checks must not wait six hours for an old upload backoff.
                // Only valid pending entries are made due; permanent failures stay visible.
                queue.makePendingDue();
                boolean uploadsWaiting = false;
                for (int i = 0; i < QueuePolicy.MAX_BATCH && !cancel.cancelled(); i++) {
                    QueueStore.Entry entry = queue.nextDue(System.currentTimeMillis()); if (entry == null) break;
                    try {
                        JSONObject payload = new JSONObject(); payload.put("requestId", entry.id); payload.put("url", entry.url);
                        JSONObject receipt = LocalApi.request(connection, "/api/phone/links", payload, cancel);
                        if (receipt.optString("jobId", "").isEmpty()) throw new IllegalStateException("Missing link receipt");
                        if (cancel.cancelled()) return Result.CANCELLED;
                        queue.accepted(entry.id);
                    } catch (LocalApi.HttpFailure failure) {
                        if (failure.status == 401 || failure.status == 403) throw failure;
                        if (failure.status == 400 || failure.status == 422) { queue.failed(entry); continue; }
                        queue.retry(entry, "Waiting for Mac"); uploadsWaiting = true; break;
                    } catch (Exception unavailable) {
                        if (cancel.cancelled()) return Result.CANCELLED;
                        queue.retry(entry, "Waiting for Mac"); uploadsWaiting = true; break;
                    }
                }
                boolean resetOnce = false;
                for (int page = 0; page < 24 && !cancel.cancelled(); page++) {
                    long previous = library.cursor(); JSONObject response;
                    try { response = LocalApi.request(connection, "/api/phone/sync?cursor=" + previous + "&limit=50", null, cancel); }
                    catch (LocalApi.HttpFailure failure) {
                        if (failure.status == 409 && failure.resetRequired && !resetOnce) { library.reset(); resetOnce = true; continue; }
                        throw failure;
                    }
                    if (cancel.cancelled()) return Result.CANCELLED;
                    SyncPage next = new SyncPage(response, previous); library.apply(next, previous, connection.fingerprint);
                    if (!next.hasMore) return uploadsWaiting ? Result.WAITING : queue.pendingCount() > 0 ? Result.MORE : Result.SYNCED;
                }
                return cancel.cancelled() ? Result.CANCELLED : Result.MORE;
            } catch (LocalApi.HttpFailure failure) {
                if (failure.status == 401) {
                    devices.setRevoked(); setState(context, "Pair your Mac again"); return Result.UNPAIRED;
                }
                setState(context, failure.status == 403 ? "Check Mac addresses" : "Mac unavailable"); return Result.WAITING;
            } catch (Exception unavailable) {
                if (cancel.cancelled()) return Result.CANCELLED;
                setState(context, "Mac unavailable"); return Result.WAITING;
            }
            } finally { if (running == cancel) running = null; }
        }
    }
    private static void setState(Context context, String value) { try (LibraryStore library = new LibraryStore(context)) { library.state(value); } catch (Exception ignored) { } }
    private static void stopCurrent() { LocalApi.Cancellation active = running; if (active != null) active.cancel(); }
    public static void requestDisconnect() { disconnecting = true; stopCurrent(); }
    public static void updateAddresses(Context context, LocalConnection expected, LocalConnection updated) throws Exception {
        stopCurrent();
        synchronized (LOCK) {
            if (disconnecting || changing) throw new IllegalStateException("Connection changed");
            LocalDeviceStore devices = new LocalDeviceStore(context); LocalConnection current = devices.load();
            if (current == null || !current.deviceId.equals(expected.deviceId) || !current.fingerprint.equals(expected.fingerprint) || !current.token.equals(expected.token)) throw new IllegalStateException("Connection changed");
            devices.save(updated);
        }
    }
    public static void disconnect(Context context) {
        requestDisconnect();
        try {
            synchronized (LOCK) {
            new LocalDeviceStore(context).disconnect();
            try (LibraryStore library = new LibraryStore(context)) { library.reset(); library.state("Pair your Mac"); }
        }
        } finally { disconnecting = false; }
    }
}
