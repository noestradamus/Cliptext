package life.cliptext.save;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/** Persist, schedule, finish. Sharing never opens a library or a connection screen. */
public final class ReceiveActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            Intent intent = getIntent(); if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            String url = VideoUrlParser.extract(text == null ? null : text.toString(), intent.getStringExtra(Intent.EXTRA_SUBJECT));
            if (url == null) { Toast.makeText(this, "Share a TikTok, YouTube, or Instagram link.", Toast.LENGTH_SHORT).show(); return; }
            try (QueueStore store = new QueueStore(this)) { store.enqueue(url); }
            SyncScheduler.soon(this, 0);
            Toast.makeText(this, "Saved to Cliptext", Toast.LENGTH_SHORT).show();
        } catch (Exception unavailable) { Toast.makeText(this, "Could not save. Check the Cliptext Share queue.", Toast.LENGTH_LONG).show(); }
        finally { finish(); }
    }
}
