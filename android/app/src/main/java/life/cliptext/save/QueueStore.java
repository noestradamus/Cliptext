package life.cliptext.save;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.UUID;

public final class QueueStore extends SQLiteOpenHelper {
    public static final class Entry {
        public final String id, url;
        public final int attempts;
        Entry(String id, String url, int attempts) { this.id = id; this.url = url; this.attempts = attempts; }
    }
    public QueueStore(Context context) { super(context.getApplicationContext(), "cliptext-share-queue.db", null, 1); setWriteAheadLoggingEnabled(true); }
    @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE queue(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,last_error TEXT)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    /** A committed SQLite transaction finishes before the share Activity exits. */
    public String enqueue(String input) {
        String url = VideoUrlParser.normalize(input);
        if (url == null) throw new IllegalArgumentException("Invalid video link");
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            try (Cursor existing = db.query("queue", new String[]{"id"}, "url=?", new String[]{url}, null, null, null)) {
                if (existing.moveToFirst()) { db.setTransactionSuccessful(); return existing.getString(0); }
            }
            if (count(db, null) >= QueuePolicy.MAX_PENDING) throw new IllegalStateException("Share queue is full");
            String id = UUID.randomUUID().toString();
            ContentValues values = new ContentValues();
            values.put("id", id); values.put("url", url); values.put("created_at", System.currentTimeMillis());
            db.insertOrThrow("queue", null, values);
            db.setTransactionSuccessful();
            return id;
        } finally { db.endTransaction(); }
    }

    public Entry nextDue(long now) {
        try (Cursor cursor = getReadableDatabase().query("queue", new String[]{"id", "url", "attempts"}, "state='pending' AND next_at<=?", new String[]{Long.toString(now)}, null, null, "created_at ASC", "1")) {
            return cursor.moveToFirst() ? new Entry(cursor.getString(0), cursor.getString(1), cursor.getInt(2)) : null;
        }
    }
    public long nextAttemptAt() {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT MIN(next_at) FROM queue WHERE state='pending'", null)) {
            return cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : -1;
        }
    }
    public int pendingCount() { return count(getReadableDatabase(), "pending"); }
    public int failedCount() { return count(getReadableDatabase(), "failed"); }
    public java.util.List<String[]> entries() {
        java.util.ArrayList<String[]> rows = new java.util.ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("queue", new String[]{"url", "state", "last_error"}, null, null, null, null, "created_at ASC", "1000")) {
            while (cursor.moveToNext()) rows.add(new String[]{cursor.getString(0), cursor.getString(1), cursor.getString(2)});
        }
        return rows;
    }
    private static int count(SQLiteDatabase db, String state) {
        try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM queue" + (state == null ? "" : " WHERE state=?"), state == null ? null : new String[]{state})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }
    public void accepted(String id) { getWritableDatabase().delete("queue", "id=?", new String[]{id}); }
    public void retry(Entry entry, String reason) {
        ContentValues values = new ContentValues();
        values.put("attempts", entry.attempts + 1);
        values.put("next_at", System.currentTimeMillis() + QueuePolicy.retryDelayMillis(entry.attempts));
        values.put("last_error", reason);
        getWritableDatabase().update("queue", values, "id=?", new String[]{entry.id});
    }
    public void failed(Entry entry) {
        ContentValues values = new ContentValues(); values.put("state", "failed"); values.put("last_error", "This link could not be saved.");
        getWritableDatabase().update("queue", values, "id=?", new String[]{entry.id});
    }
    public void retryAll() {
        ContentValues values = new ContentValues(); values.put("state", "pending"); values.put("next_at", 0); values.put("attempts", 0); values.putNull("last_error");
        getWritableDatabase().update("queue", values, null, null);
    }
    public void makePendingDue() {
        ContentValues values = new ContentValues(); values.put("next_at", 0);
        getWritableDatabase().update("queue", values, "state='pending'", null);
    }
}
