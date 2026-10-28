package life.cliptext.save;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

public class SyncPageTest {
    private JSONObject page(long cursor, boolean more, Object... changes) throws Exception { JSONObject page = new JSONObject(); page.put("cursor", cursor); page.put("hasMore", more); page.put("collections", new JSONArray()); page.put("changes", new JSONArray(changes)); return page; }
    private JSONObject change(long seq, String id, boolean deleted) throws Exception { JSONObject change = new JSONObject(); change.put("seq", seq); change.put("id", id); change.put("deleted", deleted); if (!deleted) change.put("job", new JSONObject().put("id", id).put("transcript", "Saved words")); return change; }
    @Test public void acceptsUpsertsAndTombstones() throws Exception { SyncPage next = new SyncPage(page(8, false, change(5, "a", false), change(8, "b", true)), 3); assertEquals(8, next.cursor); assertEquals(2, next.changes.length()); }
    @Test public void permitsEmptyCurrentPage() throws Exception { assertEquals(7, new SyncPage(page(7, false), 7).cursor); }
    @Test public void preventsCursorRollback() throws Exception { invalid(page(3, false), 5); }
    @Test public void preventsReplayOrUnorderedEvents() throws Exception { invalid(page(8, false, change(6, "a", false), change(5, "b", true)), 3); invalid(page(8, false, change(3, "a", false)), 3); }
    @Test public void rejectsChangesPastCursor() throws Exception { invalid(page(8, false, change(9, "a", false)), 3); }
    @Test public void refusesUnseenCursorAdvance() throws Exception { invalid(page(8, false), 7); invalid(page(8, false, change(7, "a", false)), 3); }
    @Test public void rejectsWrongItemId() throws Exception { JSONObject change = change(6, "a", false); change.getJSONObject("job").put("id", "b"); invalid(page(6, false, change), 3); }
    @Test public void refusesNonAdvancingMore() throws Exception { invalid(page(7, true), 7); invalid(page(8, true), 7); }
    @Test public void refusesIncompletePayloads() throws Exception { JSONObject page = page(6, false, change(6, "a", false)); page.getJSONArray("changes").getJSONObject(0).remove("job"); invalid(page, 3); }
    private void invalid(JSONObject page, long previous) throws Exception { try { new SyncPage(page, previous); fail(); } catch (IllegalArgumentException expected) { } catch (org.json.JSONException expected) { } }
}
