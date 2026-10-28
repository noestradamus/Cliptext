package life.cliptext.save;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class SetupActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private LocalApi.Cancellation active;
    private LinearLayout content, rows;
    private TextView status;
    private Button syncButton;
    private int tab, limit = 100;
    private String search = "", collection, incomingCode = "";
    private boolean busy, destroyed;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) { tab = state.getInt("tab", 0); search = state.getString("search", ""); collection = state.getString("collection"); }
        readCode(getIntent()); SyncScheduler.ensurePeriodic(this); render();
        if (incomingCode.isEmpty()) sync(false);
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readCode(intent); render(); }
    private void readCode(Intent intent) {
        Uri uri = intent == null ? null : intent.getData();
        if (uri == null || !"cliptextshare".equals(uri.getScheme()) || !"connect".equals(uri.getHost())) return;
        String code = uri.getQueryParameter("code");
        if (code != null && code.length() <= 8192 && code.matches("[A-Za-z0-9_-]+={0,2}")) { incomingCode = code; tab = 2; }
        else Toast.makeText(this, "Invalid pairing code", Toast.LENGTH_SHORT).show();
    }
    @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); state.putInt("tab", tab); state.putString("search", search); state.putString("collection", collection); }
    @Override protected void onResume() { super.onResume(); if (content != null) { updateStatus(); if (tab == 0) populateRows(); } }
    private void render() {
        LinearLayout root = NativeUi.column(this); root.setBackgroundColor(NativeUi.PAPER); NativeUi.insets(this, root);
        LinearLayout heading = new LinearLayout(this); heading.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = NativeUi.text(this, "Cliptext", 28, true); heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        syncButton = NativeUi.button(this, busy ? "Syncing…" : "Sync", false); syncButton.setEnabled(!busy); syncButton.setOnClickListener(view -> sync(true)); heading.addView(syncButton);
        root.addView(heading); status = NativeUi.text(this, "", 13, false); status.setTextColor(NativeUi.MUTED); root.addView(status);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); content = NativeUi.column(this); scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout nav = new LinearLayout(this); String[] tabs = {"Library", "Queue", "Connection"};
        for (int i = 0; i < tabs.length; i++) { final int target = i; Button button = NativeUi.button(this, tabs[i], tab == i); button.setContentDescription(tabs[i] + (tab == i ? ", selected" : "")); button.setOnClickListener(view -> { tab = target; render(); }); nav.addView(button, new LinearLayout.LayoutParams(0, -2, 1)); }
        root.addView(nav); setContentView(root); updateStatus();
        if (tab == 0) library(); else if (tab == 1) queue(); else connection();
    }
    private void updateStatus() {
        try (LibraryStore library = new LibraryStore(this); QueueStore queue = new QueueStore(this)) {
            long time = library.lastSynced(); String value = busy ? "Syncing…" : library.state();
            if (time > 0) value += " · " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(time));
            if (queue.pendingCount() > 0) value += " · " + queue.pendingCount() + " queued";
            status.setText(value); syncButton.setText(busy ? "Syncing…" : "Sync"); syncButton.setEnabled(!busy);
        } catch (Exception ignored) { status.setText("Library unavailable"); }
    }
    private void library() {
        EditText input = NativeUi.field(this, "Search library", false); input.setText(search); input.setContentDescription("Search library"); content.addView(input); NativeUi.space(this, content, 8);
        List<String[]> collections;
        try (LibraryStore library = new LibraryStore(this)) { collections = library.collections(); }
        if (!collections.isEmpty()) {
            Spinner picker = new Spinner(this); ArrayList<String> labels = new ArrayList<>(); labels.add("All collections"); int selected = 0;
            for (int i = 0; i < collections.size(); i++) { labels.add(collections.get(i)[1]); if (collections.get(i)[0].equals(collection)) selected = i + 1; }
            picker.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, labels)); picker.setSelection(selected); picker.setContentDescription("Collection"); picker.setMinimumHeight(NativeUi.dp(this, 48));
            picker.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { collection = position == 0 ? null : collections.get(position - 1)[0]; limit = 100; populateRows(); }
                @Override public void onNothingSelected(AdapterView<?> parent) { }
            }); content.addView(picker);
        }
        rows = NativeUi.column(this); content.addView(rows);
        input.addTextChangedListener(new TextWatcher() { @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { } @Override public void onTextChanged(CharSequence s, int start, int before, int count) { search = s.toString(); limit = 100; populateRows(); } @Override public void afterTextChanged(Editable text) { } });
        populateRows();
    }
    private void populateRows() {
        if (rows == null || tab != 0) return; rows.removeAllViews();
        try (LibraryStore library = new LibraryStore(this)) {
            LocalConnection current = saved();
            if (current != null && !current.fingerprint.equals(library.scope())) { rows.addView(NativeUi.text(this, "Sync to load this Mac’s library", 18, true)); return; }
            List<JSONObject> items = library.items(search, collection, limit);
            if (items.isEmpty()) {
                rows.addView(NativeUi.text(this, search.isEmpty() ? "No saved transcripts" : "No results", 18, true));
                if (search.isEmpty()) rows.addView(NativeUi.text(this, "Share a link to Save to Cliptext, then sync with your Mac.", 15, false));
            }
            for (JSONObject item : items) {
                LinearLayout row = NativeUi.card(this);
                String title = item.optString("title", ""); if (title.trim().isEmpty() || "null".equals(title)) title = "Untitled";
                TextView name = NativeUi.text(this, title, 18, true); name.setMaxLines(3); name.setEllipsize(android.text.TextUtils.TruncateAt.END); row.addView(name);
                String creator = item.optString("creator", ""); if ("null".equals(creator)) creator = "";
                String subtitle = creator.isEmpty() ? item.optString("platform", "") : creator + " · " + item.optString("platform", "");
                String state = item.optString("status", ""); if (!"completed".equals(state)) subtitle += " · " + ("failed".equals(state) ? "Error" : "Preparing");
                TextView meta = NativeUi.text(this, subtitle, 13, false); meta.setTextColor(NativeUi.MUTED); row.addView(meta);
                row.setFocusable(true); row.setContentDescription(title + ", " + subtitle); row.setOnClickListener(view -> startActivity(new Intent(this, ReaderActivity.class).putExtra("id", item.optString("id")))); rows.addView(row);
            }
            if (items.size() >= limit && limit < 10000) { Button more = NativeUi.button(this, "Show more", false); more.setOnClickListener(view -> { limit += 100; populateRows(); }); rows.addView(more); }
        }
    }
    private void queue() {
        TextView heading = NativeUi.text(this, "Queued links", 22, true); content.addView(heading);
        EditText input = NativeUi.field(this, "Paste a link", false); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); content.addView(input);
        Button save = NativeUi.button(this, "Save link", true); save.setOnClickListener(view -> {
            String url = VideoUrlParser.extract(input.getText().toString());
            if (url == null) { input.setError("Enter a TikTok, YouTube, or Instagram link"); return; }
            try (QueueStore queue = new QueueStore(this)) { queue.enqueue(url); } catch (Exception failure) { input.setError("Could not save this link"); return; }
            SyncScheduler.soon(this, 0); render(); sync(true);
        }); content.addView(save); NativeUi.space(this, content, 12);
        try (QueueStore queue = new QueueStore(this)) {
            if (queue.failedCount() > 0) { Button retry = NativeUi.button(this, "Retry failed links", false); retry.setOnClickListener(view -> { try (QueueStore store = new QueueStore(this)) { store.retryAll(); } SyncScheduler.soon(this, 0); sync(true); }); content.addView(retry); }
            List<String[]> links = queue.entries();
            if (links.isEmpty()) content.addView(NativeUi.text(this, "No queued links", 16, false));
            for (String[] entry : links) { LinearLayout card = NativeUi.card(this); TextView url = NativeUi.text(this, entry[0], 15, false); url.setTextIsSelectable(true); card.addView(url); card.addView(NativeUi.text(this, "failed".equals(entry[1]) ? "Could not save · Retry available" : "Waiting for Mac", 13, false)); content.addView(card); }
        }
    }
    private LocalConnection saved() { try { return new LocalDeviceStore(this).load(); } catch (Exception unavailable) { return null; } }
    private void connection() {
        content.addView(NativeUi.text(this, "Mac connection", 22, true)); LocalConnection current = saved();
        boolean revoked = new LocalDeviceStore(this).revoked();
        if (current != null && incomingCode.isEmpty() && !revoked) {
            content.addView(NativeUi.text(this, "Paired", 18, true));
            content.addView(NativeUi.text(this, "Offline transcripts stay on this phone. Queued links sync when your Mac is reachable.", 15, false));
            content.addView(NativeUi.text(this, "Mac addresses", 14, true)); EditText addresses = NativeUi.field(this, "https://your-mac:47322", true); addresses.setText(String.join("\n", current.endpoints)); addresses.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_VARIATION_URI); content.addView(addresses);
            Button update = NativeUi.button(this, "Save addresses", false); update.setOnClickListener(view -> {
                try {
                    LocalConnection changed = current.withEndpoints(addresses.getText().toString());
                    if (active != null) active.cancel();
                    executor.execute(() -> {
                        try { SyncRunner.updateAddresses(getApplicationContext(), current, changed); main.post(() -> { if (!destroyed) { busy = false; SyncScheduler.soon(this, 0); sync(true); } }); }
                        catch (Exception invalid) { main.post(() -> { if (!destroyed) { busy = false; addresses.setError("Connection changed. Open Connection again."); updateStatus(); } }); }
                    });
                }
                catch (Exception invalid) { addresses.setError("Use HTTPS addresses with port, one per line"); }
            }); content.addView(update);
            TextView tailscale = NativeUi.text(this, "Away from home: turn on Tailscale on both devices and add the Mac’s Tailscale address above.", 14, false); content.addView(tailscale);
            Button replace = NativeUi.button(this, "Pair again", false); replace.setOnClickListener(view -> { incomingCode = " "; render(); }); content.addView(replace);
            addDisconnect(); return;
        }
        if (revoked) content.addView(NativeUi.text(this, "Pair your Mac again. Saved transcripts and queued links are still on this phone.", 15, false));
        content.addView(NativeUi.text(this, "On your Mac: Sharing setup → Phone sharing → Pair phone.", 15, false));
        content.addView(NativeUi.text(this, "Pairing code", 14, true)); EditText code = NativeUi.field(this, "Paste the code from your Mac", true); code.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); code.setText(incomingCode.trim()); code.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD); content.addView(code);
        TextView error = NativeUi.text(this, "", 14, false); error.setTextColor(android.graphics.Color.rgb(165, 45, 45)); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(error);
        Button connect = NativeUi.button(this, "Connect", true); connect.setEnabled(!busy); connect.setOnClickListener(view -> {
            LocalConnection candidate;
            try { candidate = LocalConnection.parseCode(code.getText().toString()); } catch (Exception invalid) { code.setError("Copy a new pairing code from your Mac"); return; }
            if (busy) return; busy = true; connect.setEnabled(false); connect.setText("Connecting…"); active = new LocalApi.Cancellation(); final LocalApi.Cancellation cancel = active;
            executor.execute(() -> {
                try {
                    SyncRunner.pair(getApplicationContext(), candidate, android.os.Build.MODEL, cancel);
                    SyncRunner.run(getApplicationContext(), cancel, true);
                    main.post(() -> { if (destroyed) return; busy = false; incomingCode = ""; tab = 0; render(); });
                } catch (Exception unavailable) {
                    main.post(() -> { if (destroyed) return; busy = false; connect.setEnabled(true); connect.setText("Connect"); error.setText("Could not connect. Keep Cliptext open on your Mac and use the same Wi-Fi or Tailscale. If the code expired, create a new one."); updateStatus(); });
                }
            });
        }); content.addView(connect);
        if (current != null && !revoked) { Button cancelPair = NativeUi.button(this, "Cancel pairing", false); cancelPair.setOnClickListener(view -> { incomingCode = ""; render(); }); content.addView(cancelPair); }
        if (current != null) addDisconnect();
        content.addView(NativeUi.text(this, "Sharing still works while the Mac sleeps. Android may delay background sync; Sync checks immediately.", 14, false));
    }
    private void addDisconnect() {
        Button disconnect = NativeUi.button(this, "Disconnect", false);
        disconnect.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("Disconnect Mac?").setMessage("Remove this connection and offline transcripts? Queued links stay on this phone.").setNegativeButton("Cancel", null).setPositiveButton("Disconnect", (dialog, which) -> {
            if (active != null) active.cancel(); SyncRunner.requestDisconnect();
            executor.execute(() -> { SyncRunner.disconnect(getApplicationContext()); main.post(() -> { if (!destroyed) { busy = false; incomingCode = ""; render(); } }); });
        }).show()); content.addView(disconnect);
    }
    private void sync(boolean explicit) {
        if (busy || destroyed) return;
        LocalConnection connection = saved();
        if (connection == null || new LocalDeviceStore(this).revoked()) { if (explicit) { tab = 2; render(); } return; }
        busy = true; updateStatus(); active = new LocalApi.Cancellation(); final LocalApi.Cancellation cancel = active;
        executor.execute(() -> {
            SyncRunner.Result result = SyncRunner.run(getApplicationContext(), cancel, true);
            if (result == SyncRunner.Result.MORE) SyncScheduler.soon(getApplicationContext(), 0);
            main.post(() -> { if (destroyed) return; busy = false; if (tab == 0) { populateRows(); updateStatus(); } else render(); });
        });
    }
    @Override protected void onDestroy() { destroyed = true; if (active != null) active.cancel(); executor.shutdownNow(); super.onDestroy(); }
}
