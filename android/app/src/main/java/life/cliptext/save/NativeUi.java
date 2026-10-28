package life.cliptext.save;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

final class NativeUi {
    static final int INK = Color.rgb(42, 73, 123), ACCENT = Color.rgb(31, 113, 166), PAPER = Color.rgb(238, 248, 255), MUTED = Color.rgb(77, 100, 127);
    static int dp(Activity activity, int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    static TextView text(Activity activity, String value, int sp, boolean bold) {
        TextView view = new TextView(activity); view.setText(value); view.setTextSize(sp); view.setTextColor(INK);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setPadding(0, 0, 0, dp(activity, 8)); return view;
    }
    static Button button(Activity activity, String label, boolean primary) {
        Button button = new Button(activity); button.setText(label); button.setAllCaps(false); button.setTextSize(16); button.setMinHeight(dp(activity, 48));
        button.setTextColor(primary ? Color.WHITE : INK); button.setBackgroundTintList(ColorStateList.valueOf(primary ? ACCENT : Color.rgb(220, 237, 247))); return button;
    }
    static EditText field(Activity activity, String hint, boolean multiline) {
        EditText field = new EditText(activity); field.setHint(hint); field.setTextSize(16); field.setTextColor(INK); field.setHintTextColor(MUTED); field.setSingleLine(!multiline);
        field.setMinHeight(dp(activity, 52)); field.setPadding(dp(activity, 12), dp(activity, 8), dp(activity, 12), dp(activity, 8));
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.WHITE); background.setCornerRadius(dp(activity, 12)); background.setStroke(dp(activity, 1), Color.rgb(183, 210, 226)); field.setBackground(background);
        if (multiline) { field.setMinLines(3); field.setMaxLines(5); }
        return field;
    }
    static LinearLayout column(Activity activity) { LinearLayout layout = new LinearLayout(activity); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    static void insets(Activity activity, View root) {
        int base = dp(activity, 16);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(base + bars.left, base + bars.top, base + bars.right, base + bars.bottom);
            } else view.setPadding(base + insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop() + base, base + insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom() + base);
            return insets;
        }); root.requestApplyInsets();
    }
    static void space(Activity activity, LinearLayout layout, int height) { View view = new View(activity); layout.addView(view, new LinearLayout.LayoutParams(1, dp(activity, height))); }
    static LinearLayout card(Activity activity) {
        LinearLayout card = column(activity); card.setPadding(dp(activity, 16), dp(activity, 16), dp(activity, 16), dp(activity, 12));
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.WHITE); background.setCornerRadius(dp(activity, 18)); card.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(activity, 12)); card.setLayoutParams(params); return card;
    }
    private NativeUi() { }
}
