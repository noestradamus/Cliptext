package life.cliptext.save;

/** Compatibility entry point for earlier receiver/tests; use VideoUrlParser. */
public final class TikTokUrlParser {
    private TikTokUrlParser() { }
    public static String extract(String... parts) { return VideoUrlParser.extract(parts); }
    public static boolean isAllowed(String value) { return VideoUrlParser.isAllowed(value); }
}
