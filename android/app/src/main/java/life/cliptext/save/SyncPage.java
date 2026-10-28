package life.cliptext.save;

import org.json.JSONArray;
import org.json.JSONObject;

/** Validate the complete page before an atomic SQLite commit. */
public final class SyncPage {
    public final JSONArray changes, collections;
    public final long cursor;
    public final boolean hasMore;
    public SyncPage(JSONObject json, long previous) throws Exception {
        changes = json.getJSONArray("changes"); collections = json.getJSONArray("collections");
        cursor = json.getLong("cursor"); hasMore = json.getBoolean("hasMore");
        if (cursor < previous || changes.length() > 50 || collections.length() > 10000) throw new IllegalArgumentException("Invalid sync cursor");
        long sequence = previous;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i);
            long next = change.getLong("seq"); String id = change.getString("id");
            if (next <= sequence || next > cursor || id.isEmpty() || id.length() > 128) throw new IllegalArgumentException("Invalid sync change");
            if (!change.getBoolean("deleted")) {
                JSONObject job = change.getJSONObject("job");
                if (!id.equals(job.getString("id"))) throw new IllegalArgumentException("Invalid sync item");
            }
            sequence = next;
        }
        if (cursor != sequence) throw new IllegalArgumentException("Cursor skips an unseen sync change");
        if (hasMore && (changes.length() == 0 || cursor <= previous)) throw new IllegalArgumentException("Sync did not advance");
        for (int i = 0; i < collections.length(); i++) {
            JSONObject collection = collections.getJSONObject(i);
            if (collection.getString("id").length() > 128 || collection.getString("name").length() > 500) throw new IllegalArgumentException("Invalid collection");
        }
    }
}
