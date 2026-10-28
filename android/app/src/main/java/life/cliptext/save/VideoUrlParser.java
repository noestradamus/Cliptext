package life.cliptext.save;

import java.net.URI;
import java.net.URLDecoder;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Exact post hosts/paths; normalizes shared links without fetching them. */
public final class VideoUrlParser {
    private static final Set<String> TIKTOK = hosts("tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com", "m.tiktok.com");
    private static final Set<String> YOUTUBE = hosts("youtube.com", "www.youtube.com", "m.youtube.com");
    private static final Set<String> YOUTUBE_SHORT = hosts("youtu.be", "www.youtu.be");
    private static final Set<String> INSTAGRAM = hosts("instagram.com", "www.instagram.com", "m.instagram.com");
    private static final Pattern LINKS = Pattern.compile("https://[^\\s<>\"'\\p{Cntrl}]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern TRAVERSAL = Pattern.compile("(?:/|%2f)(?:\\.|%2e){1,2}(?:/|%2f|[?#]|$)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SHORT_PATH = Pattern.compile("/[A-Za-z0-9_-]{4,80}/?");
    private static final Pattern TIKTOK_PATH = Pattern.compile("/@[^/]+/(?:video|photo)/\\d{10,25}/?");
    private static final Pattern WEB_SHORT_PATH = Pattern.compile("/t/[A-Za-z0-9_-]{4,80}/?");
    private static final Pattern YOUTUBE_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final Pattern YOUTUBE_SHORTS = Pattern.compile("/shorts/([A-Za-z0-9_-]{11})/?");
    private static final Pattern YOUTUBE_SHORT_LINK = Pattern.compile("/([A-Za-z0-9_-]{11})/?");
    private static final Pattern INSTAGRAM_PATH = Pattern.compile("/(reel|reels|p)/([A-Za-z0-9_-]{5,64})/?");
    private static final String TRAILING = ".,;:!?)]}，。！？…";
    private VideoUrlParser() { }
    private static Set<String> hosts(String... values) { return new HashSet<String>(Arrays.asList(values)); }

    public static String extract(String... parts) {
        if (parts == null) return null;
        for (String part : parts) {
            if (part == null || part.length() > 12000) continue;
            Matcher matcher = LINKS.matcher(part);
            while (matcher.find()) {
                String candidate = matcher.group();
                if (TRAVERSAL.matcher(candidate).find()) continue;
                while (!candidate.isEmpty() && TRAILING.indexOf(candidate.charAt(candidate.length() - 1)) >= 0) candidate = candidate.substring(0, candidate.length() - 1);
                String result = normalize(candidate);
                if (result != null) return result;
            }
        }
        return null;
    }
    public static boolean isAllowed(String value) { return normalize(value) != null; }
    public static String normalize(String value) {
        if (value == null || value.length() > 2048 || TRAVERSAL.matcher(value).find()) return null;
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            String host = uri.getHost().toLowerCase(Locale.ROOT), path = uri.getRawPath();
            if (path == null) return null;
            if (TIKTOK.contains(host)) {
                boolean shortHost = host.equals("vt.tiktok.com") || host.equals("vm.tiktok.com");
                if (shortHost ? !SHORT_PATH.matcher(path).matches() : !TIKTOK_PATH.matcher(path).matches() && !WEB_SHORT_PATH.matcher(path).matches()) return null;
                return new URI("https://" + host + path).toASCIIString();
            }
            if (YOUTUBE_SHORT.contains(host)) {
                Matcher shortLink = YOUTUBE_SHORT_LINK.matcher(path);
                return shortLink.matches() ? youtube(shortLink.group(1)) : null;
            }
            if (YOUTUBE.contains(host)) {
                Matcher shorts = YOUTUBE_SHORTS.matcher(path);
                if (shorts.matches()) return youtube(shorts.group(1));
                if ((!path.equals("/watch") && !path.equals("/watch/")) || uri.getRawQuery() == null) return null;
                String videoId = null; int values = 0;
                for (String parameter : uri.getRawQuery().split("&", -1)) {
                    int equals = parameter.indexOf('=');
                    String key = URLDecoder.decode(equals < 0 ? parameter : parameter.substring(0, equals), "UTF-8");
                    if (key.equals("v")) {
                        values++;
                        videoId = URLDecoder.decode(equals < 0 ? "" : parameter.substring(equals + 1), "UTF-8");
                    }
                }
                return values == 1 && videoId != null && YOUTUBE_ID.matcher(videoId).matches() ? youtube(videoId) : null;
            }
            if (INSTAGRAM.contains(host)) {
                Matcher media = INSTAGRAM_PATH.matcher(path);
                if (!media.matches()) return null;
                return "https://www.instagram.com/" + (media.group(1).equals("p") ? "p" : "reel") + "/" + media.group(2) + "/";
            }
        } catch (Exception ignored) { /* Reject malformed, unrelated, or unsafe URLs. */ }
        return null;
    }
    private static String youtube(String id) { return "https://www.youtube.com/watch?v=" + id; }
}
