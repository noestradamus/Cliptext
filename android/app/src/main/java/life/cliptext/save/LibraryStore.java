package life.cliptext.save;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/** Read-only replica. Each page and its cursor are committed together. */
public final class LibraryStore extends SQLiteOpenHelper {
    public LibraryStore(Context context) { super(context.getApplicationContext(), "cliptext-offline-library.db", null, 1); setWriteAheadLoggingEnabled(true); }
    @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE items(id TEXT PRIMARY KEY,title TEXT NOT NULL,creator TEXT,platform TEXT,status TEXT,collection_id TEXT,created_at TEXT NOT NULL)");
        db.execSQL("CREATE TABLE item_chunks(id TEXT NOT NULL,part INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,part))");
        db.execSQL("CREATE INDEX items_created ON items(created_at DESC,id)");
        db.execSQL("CREATE TABLE collections(id TEXT PRIMARY KEY,name TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }
    private static String meta(SQLiteDatabase db, String key, String fallback) {
        try (Cursor cursor = db.query("meta", new String[]{"value"}, "key=?", new String[]{key}, null, null, null)) { return cursor.moveToFirst() ? cursor.getString(0) : fallback; }
    }
    private static void putMeta(SQLiteDatabase db, String key, String value) {
        ContentValues values = new ContentValues(); values.put("key", key); values.put("value", value); db.insertWithOnConflict("meta", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }
    public String scope() { return meta(getReadableDatabase(), "scope", ""); }
    public long cursor() { try { return Long.parseLong(meta(getReadableDatabase(), "cursor", "0")); } catch (NumberFormatException invalid) { return 0; } }
    public long lastSynced() { try { return Long.parseLong(meta(getReadableDatabase(), "lastSynced", "0")); } catch (NumberFormatException invalid) { return 0; } }
    public String state() { return meta(getReadableDatabase(), "state", "Not synced yet"); }
    public void state(String value) { putMeta(getWritableDatabase(), "state", value); }
    public void ensureScope(String fingerprint) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            if (!fingerprint.equals(meta(db, "scope", ""))) { db.delete("items", null, null); db.delete("item_chunks", null, null); db.delete("collections", null, null); db.delete("meta", null, null); putMeta(db, "scope", fingerprint); putMeta(db, "cursor", "0"); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    public void reset() {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try { db.delete("items", null, null); db.delete("item_chunks", null, null); db.delete("collections", null, null); putMeta(db, "cursor", "0"); putMeta(db, "lastSynced", "0"); db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }
    public void apply(SyncPage page, long previous, String fingerprint) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            if (!fingerprint.equals(meta(db, "scope", "")) || cursor() != previous) throw new IllegalStateException("Library changed during sync");
            for (int i = 0; i < page.changes.length(); i++) {
                JSONObject change = page.changes.getJSONObject(i); String id = change.getString("id");
                db.delete("item_chunks", "id=?", new String[]{id});
                if (change.getBoolean("deleted")) db.delete("items", "id=?", new String[]{id});
                else {
                    JSONObject job = change.getJSONObject("job"); ContentValues values = new ContentValues();
                    values.put("id", id); values.put("title", job.optString("title", "Untitled"));
                    values.put("creator", job.optString("creator", "")); values.put("platform", job.optString("platform", "")); values.put("status", job.optString("status", ""));
                    values.put("collection_id", job.isNull("collectionId") ? null : job.optString("collectionId", null));
                    values.put("created_at", job.optString("createdAt", ""));
                    db.insertWithOnConflict("items", null, values, SQLiteDatabase.CONFLICT_REPLACE);
                    java.util.List<String> chunks = CacheChunks.split(job.toString());
                    for (int part = 0; part < chunks.size(); part++) {
                        ContentValues chunk = new ContentValues(); chunk.put("id", id); chunk.put("part", part); chunk.put("text", chunks.get(part)); db.insertOrThrow("item_chunks", null, chunk);
                    }
                }
            }
            db.delete("collections", null, null);
            for (int i = 0; i < page.collections.length(); i++) {
                JSONObject collection = page.collections.getJSONObject(i); ContentValues values = new ContentValues();
                values.put("id", collection.getString("id")); values.put("name", collection.getString("name")); db.insertOrThrow("collections", null, values);
            }
            putMeta(db, "cursor", Long.toString(page.cursor));
            if (!page.hasMore) { putMeta(db, "lastSynced", Long.toString(System.currentTimeMillis())); putMeta(db, "state", "Synced"); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    public List<JSONObject> items(String search, String collection, int limit) {
        ArrayList<JSONObject> items = new ArrayList<>(); String selection = null; ArrayList<String> args = new ArrayList<>();
        if (search != null && !search.isEmpty()) { selection = "(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM item_chunks c WHERE c.id=items.id AND c.text LIKE ? ESCAPE '\\'))"; String term = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; args.add(term); args.add(term); }
        if (collection != null) { selection = (selection == null ? "" : selection + " AND ") + "collection_id=?"; args.add(collection); }
        try (Cursor cursor = getReadableDatabase().query("items", new String[]{"id", "title", "creator", "platform", "status", "collection_id"}, selection, args.toArray(new String[0]), null, null, "created_at DESC,id", Integer.toString(Math.max(1, Math.min(10000, limit))))) {
            while (cursor.moveToNext()) { try { JSONObject row = new JSONObject(); row.put("id", cursor.getString(0)); row.put("title", cursor.getString(1)); row.put("creator", cursor.getString(2)); row.put("platform", cursor.getString(3)); row.put("status", cursor.getString(4)); row.put("collectionId", cursor.getString(5)); items.add(row); } catch (Exception invalid) { /* One invalid legacy row must not hide the rest. */ } }
        }
        return items;
    }
    public JSONObject item(String id) {
        java.util.ArrayList<String> chunks = new java.util.ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("item_chunks", new String[]{"part", "text"}, "id=?", new String[]{id}, null, null, "part ASC")) {
            while (cursor.moveToNext()) { if (cursor.getInt(0) != chunks.size()) throw new IllegalStateException("Incomplete offline item"); chunks.add(cursor.getString(1)); }
        }
        if (chunks.isEmpty()) return null;
        try { return new JSONObject(CacheChunks.join(chunks)); }
        catch (org.json.JSONException invalid) { throw new IllegalStateException("Invalid offline item", invalid); }
    }
    public boolean contains(String id) {
        try (Cursor cursor = getReadableDatabase().query("items", new String[]{"id"}, "id=?", new String[]{id}, null, null, null)) { return cursor.moveToFirst(); }
    }
    public List<String[]> collections() {
        ArrayList<String[]> rows = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("collections", new String[]{"id", "name"}, null, null, null, null, "name COLLATE NOCASE")) { while (cursor.moveToNext()) rows.add(new String[]{cursor.getString(0), cursor.getString(1)}); }
        return rows;
    }
}
