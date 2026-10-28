package life.cliptext.save;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Reads only the local SQLite replica: no network is required to open an item. */
public final class ReaderActivity extends Activity {
    private String renderedScope, itemId;
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state); JSONObject job; itemId = getIntent().getStringExtra("id");
        try (LibraryStore library = new LibraryStore(this)) {
            LocalConnection current; try { current = new LocalDeviceStore(this).load(); } catch (Exception unavailable) { current = null; }
            job = current == null || !current.fingerprint.equals(library.scope()) ? null : library.item(itemId);
            if (job != null) renderedScope = current.fingerprint;
        }
        LinearLayout root = NativeUi.column(this); root.setBackgroundColor(NativeUi.PAPER); NativeUi.insets(this, root);
        Button back = NativeUi.button(this, "‹ Library", false); back.setOnClickListener(view -> finish()); root.addView(back);
        ScrollView scroll = new ScrollView(this); LinearLayout content = NativeUi.column(this); scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        if (job == null) { content.addView(NativeUi.text(this, "This item is no longer in the offline library.", 18, false)); return; }
        String title = job.optString("title", "Untitled"); if ("null".equals(title) || title.trim().isEmpty()) title = "Untitled";
        content.addView(NativeUi.text(this, title, 26, true));
        String creator = job.optString("creator", ""); if ("null".equals(creator)) creator = "";
        TextView meta = NativeUi.text(this, creator + (creator.isEmpty() ? "" : " · ") + job.optString("platform", ""), 14, false); meta.setTextColor(NativeUi.MUTED); content.addView(meta);
        String text = job.isNull("transcript") ? "" : job.optString("transcript", "");
        if (text.isEmpty()) { JSONArray pages = job.optJSONArray("pages"); StringBuilder all = new StringBuilder(); if (pages != null) for (int i = 0; i < pages.length(); i++) { JSONObject page = pages.optJSONObject(i); if (page != null) { if (all.length() > 0) all.append("\n\n"); all.append(page.optString("text", "")); } } text = all.toString(); }
        LinearLayout transcript = NativeUi.card(this); TextView words = NativeUi.text(this, text.isEmpty() ? ("failed".equals(job.optString("status")) ? "Extraction failed. Retry from your Mac." : "Preparing on your Mac…") : text, 18, false); words.setTextIsSelectable(true); words.setLineSpacing(NativeUi.dp(this, 5), 1); transcript.addView(words); content.addView(transcript);
        JSONObject insights = job.optJSONObject("insights");
        String notes = job.optString("notes", "");
        if ((insights != null && !insights.optString("summary", "").isEmpty()) || !notes.isEmpty()) {
            Button details = NativeUi.button(this, "Notes & summary", false); LinearLayout extra = NativeUi.card(this); extra.setVisibility(android.view.View.GONE);
            if (insights != null && !insights.optString("summary", "").isEmpty()) { extra.addView(NativeUi.text(this, "Summary", 15, true)); TextView summary = NativeUi.text(this, insights.optString("summary"), 16, false); summary.setMaxLines(1); summary.setEllipsize(android.text.TextUtils.TruncateAt.END); extra.addView(summary); }
            if (!notes.isEmpty()) { extra.addView(NativeUi.text(this, "Notes", 15, true)); TextView savedNotes = NativeUi.text(this, notes, 16, false); savedNotes.setTextIsSelectable(true); extra.addView(savedNotes); }
            details.setOnClickListener(view -> extra.setVisibility(extra.getVisibility() == android.view.View.VISIBLE ? android.view.View.GONE : android.view.View.VISIBLE)); content.addView(details); content.addView(extra);
        }
        String url = VideoUrlParser.normalize(job.optString("url", ""));
        if (url != null) { Button source = NativeUi.button(this, "Source ↗", false); source.setOnClickListener(view -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception unavailable) { android.widget.Toast.makeText(this, "No browser available", android.widget.Toast.LENGTH_SHORT).show(); } }); content.addView(source); }
    }
    @Override protected void onResume() {
        super.onResume(); if (renderedScope == null) return;
        try (LibraryStore library = new LibraryStore(this)) {
            LocalConnection current = new LocalDeviceStore(this).load();
            if (current != null && renderedScope.equals(current.fingerprint) && renderedScope.equals(library.scope()) && library.contains(itemId)) return;
        } catch (Exception unavailable) { }
        // A reader underneath a pairing screen must not revive a removed replica.
        setContentView(new android.view.View(this)); finish();
    }
}
