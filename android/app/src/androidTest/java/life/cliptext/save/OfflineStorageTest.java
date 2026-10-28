package life.cliptext.save;

import android.content.Context;
import android.content.SharedPreferences;
import android.app.Instrumentation;
import android.app.Activity;
import android.os.Bundle;
import android.content.ContextWrapper;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device-only tests. Isolated database/preference names never touch the user's queue. */
public final class OfflineStorageTest extends Instrumentation {
    private Context isolated;
    private String prefix;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        String[] methods = {"testQueueSurvivesReopenAndLostResponseRetryUsesSameId", "testLargeMultibyteTranscriptSurvivesSQLiteCursorWindow", "testCachePageAndCursorRollbackTogether", "testTombstonesAndChangingMacRemoveOfflineCopy", "testAndroidKeyStoreConnectionPersistsAndIgnoresHostedCredential", "testDurableTokenReplacementKeepsOfflineLibrary"};
        int failures = 0;
        for (int i = 0; i < methods.length; i++) {
            Bundle status = new Bundle(); status.putString("class", getClass().getName()); status.putString("test", methods[i]); status.putInt("numtests", methods.length); status.putInt("current", i + 1); sendStatus(1, status);
            try { setUp(); getClass().getMethod(methods[i]).invoke(this); sendStatus(0, status); }
            catch (Exception failed) { failures++; Throwable cause = failed.getCause() == null ? failed : failed.getCause(); status.putString("stack", cause.toString()); sendStatus(-2, status); }
            finally { try { tearDown(); } catch (Exception ignored) { } }
        }
        Bundle result = new Bundle(); result.putString("stream", "Offline storage tests: " + (methods.length - failures) + "/" + methods.length + " passed"); result.putInt("failures", failures); finish(failures == 0 ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
    }
    private void setUp() throws Exception { prefix = "cliptext-test-" + UUID.randomUUID().toString() + "-";
        Context target = getTargetContext();
        isolated = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getDatabasePath(String name) { return target.getDatabasePath(prefix + name); }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory) { return target.openOrCreateDatabase(prefix + name, mode, factory); }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory, DatabaseErrorHandler handler) { return target.openOrCreateDatabase(prefix + name, mode, factory, handler); }
            @Override public boolean deleteDatabase(String name) { return target.deleteDatabase(prefix + name); }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return target.getSharedPreferences(prefix + name, mode); }
        };
    }
    private void tearDown() throws Exception {
        isolated.deleteDatabase("cliptext-share-queue.db"); isolated.deleteDatabase("cliptext-offline-library.db");
        isolated.getSharedPreferences("encrypted-local-mac", Context.MODE_PRIVATE).edit().clear().commit();
        isolated.getSharedPreferences("encrypted-device-pairing", Context.MODE_PRIVATE).edit().clear().commit();
    }
    public void testQueueSurvivesReopenAndLostResponseRetryUsesSameId() {
        String url = "https://www.tiktok.com/@sample_creator/video/1234567890123456789"; String id;
        try (QueueStore queue = new QueueStore(isolated)) { id = queue.enqueue(url); assertEquals(id, queue.enqueue(url + "?tracking=one")); }
        try (QueueStore queue = new QueueStore(isolated)) {
            QueueStore.Entry entry = queue.nextDue(System.currentTimeMillis()); assertEquals(id, entry.id); assertEquals(url, entry.url);
            queue.retry(entry, "Waiting for Mac"); assertEquals(1, queue.pendingCount()); queue.makePendingDue(); assertEquals(id, queue.nextDue(System.currentTimeMillis()).id);
            queue.accepted(id); assertEquals(0, queue.pendingCount());
        }
    }
    public void testLargeMultibyteTranscriptSurvivesSQLiteCursorWindow() throws Exception {
        StringBuilder text = new StringBuilder(); for (int i = 0; i < 600000; i++) text.append("雪😀");
        String expected = text.toString(); String scope = pin('a');
        JSONObject job = new JSONObject().put("id", "large-item").put("title", "Large transcript").put("transcript", expected).put("status", "completed");
        try (LibraryStore library = new LibraryStore(isolated)) { library.ensureScope(scope); library.apply(page(1, "large-item", job, false), 0, scope); }
        try (LibraryStore library = new LibraryStore(isolated)) { assertEquals(1L, library.cursor()); assertEquals(expected, library.item("large-item").getString("transcript")); assertEquals(1, library.items("雪", null, 100).size()); }
    }
    public void testCachePageAndCursorRollbackTogether() throws Exception {
        String scope = pin('a');
        try (LibraryStore library = new LibraryStore(isolated)) {
            library.ensureScope(scope); library.apply(page(1, "a", new JSONObject().put("id", "a").put("title", "Original"), false), 0, scope);
            JSONObject bad = jsonPage(2, "b", new JSONObject().put("id", "b").put("title", "Should roll back"), false);
            JSONArray duplicateCollections = new JSONArray(); duplicateCollections.put(new JSONObject().put("id", "same").put("name", "One")); duplicateCollections.put(new JSONObject().put("id", "same").put("name", "Two")); bad.put("collections", duplicateCollections);
            try { library.apply(new SyncPage(bad, 1), 1, scope); fail("Expected a duplicate collection constraint"); } catch (android.database.SQLException expected) { }
            assertEquals(1L, library.cursor()); assertNull(library.item("b")); assertEquals("Original", library.item("a").getString("title"));
        }
    }
    public void testTombstonesAndChangingMacRemoveOfflineCopy() throws Exception {
        String scope = pin('a');
        try (LibraryStore library = new LibraryStore(isolated)) {
            library.ensureScope(scope); library.apply(page(1, "a", new JSONObject().put("id", "a"), false), 0, scope);
            library.apply(page(2, "a", null, true), 1, scope); assertNull(library.item("a")); assertEquals(0, library.items("", null, 100).size());
            library.apply(page(3, "a", new JSONObject().put("id", "a"), false), 2, scope); assertNotNull(library.item("a"));
            library.ensureScope(pin('b')); assertNull(library.item("a")); assertEquals(0L, library.cursor());
        }
    }
    public void testAndroidKeyStoreConnectionPersistsAndIgnoresHostedCredential() throws Exception {
        isolated.getSharedPreferences("encrypted-device-pairing", Context.MODE_PRIVATE).edit().putString("device", "obsolete-hosted-record").commit();
        LocalDeviceStore store = new LocalDeviceStore(isolated); assertNull(store.load());
        LocalConnection original = new LocalConnection(new String[]{"https://192.168.1.5:47322"}, pin('a'), "test-device", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG");
        store.save(original); LocalConnection reopened = new LocalDeviceStore(isolated).load();
        assertEquals(original.token, reopened.token); assertEquals(original.fingerprint, reopened.fingerprint);
        String stored = isolated.getSharedPreferences("encrypted-local-mac", Context.MODE_PRIVATE).getString("connection", ""); assertFalse(stored.contains(original.token));
        assertFalse(isolated.getSharedPreferences("encrypted-device-pairing", Context.MODE_PRIVATE).contains("device"));
        store.disconnect(); assertNull(store.load());
    }
    public void testDurableTokenReplacementKeepsOfflineLibrary() throws Exception {
        String scope = pin('a');
        try (LibraryStore library = new LibraryStore(isolated)) {
            library.ensureScope(scope); library.apply(page(1, "a", new JSONObject().put("id", "a").put("transcript", "Saved offline"), false), 0, scope);
            LocalDeviceStore devices = new LocalDeviceStore(isolated);
            devices.save(new LocalConnection(new String[]{"https://192.168.1.5:47322"}, scope, "phone", "0123456789abcdefghijklmnopqrstuvwxyzABCDEF"));
            devices.save(new LocalConnection(new String[]{"https://100.80.90.100:47322"}, scope, "new-phone-id", "ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz"));
            library.ensureScope(devices.load().fingerprint);
            assertEquals(1L, library.cursor()); assertEquals("Saved offline", library.item("a").getString("transcript"));
        }
    }
    private static void assertEquals(Object expected, Object actual) { if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("Values differ"); }
    private static void assertEquals(long expected, long actual) { if (expected != actual) throw new AssertionError("Numbers differ"); }
    private static void assertNull(Object value) { if (value != null) throw new AssertionError("Expected null"); }
    private static void assertNotNull(Object value) { if (value == null) throw new AssertionError("Expected an item"); }
    private static void assertFalse(boolean value) { if (value) throw new AssertionError("Expected false"); }
    private static void fail(String message) { throw new AssertionError(message); }
    private String pin(char value) { StringBuilder result = new StringBuilder(); for (int i = 0; i < 64; i++) result.append(value); return result.toString(); }
    private SyncPage page(long sequence, String id, JSONObject job, boolean deleted) throws Exception { return new SyncPage(jsonPage(sequence, id, job, deleted), sequence - 1); }
    private JSONObject jsonPage(long sequence, String id, JSONObject job, boolean deleted) throws Exception {
        JSONObject change = new JSONObject().put("seq", sequence).put("id", id).put("deleted", deleted); if (!deleted) change.put("job", job);
        return new JSONObject().put("cursor", sequence).put("hasMore", false).put("collections", new JSONArray()).put("changes", new JSONArray().put(change));
    }
}
