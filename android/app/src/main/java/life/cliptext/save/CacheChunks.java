package life.cliptext.save;

import java.util.ArrayList;
import java.util.List;

/** Keep each SQLite CursorWindow cell well below its ~2 MiB Android limit. */
public final class CacheChunks {
    public static final int CHARACTERS = 32768;
    public static final int MAX_CHARACTERS = 32 * 1024 * 1024;
    private CacheChunks() { }
    public static List<String> split(String value) {
        if (value == null || value.length() > MAX_CHARACTERS) throw new IllegalArgumentException("Offline item is too large");
        ArrayList<String> chunks = new ArrayList<>();
        for (int start = 0; start < value.length();) {
            int end = Math.min(value.length(), start + CHARACTERS);
            if (end < value.length() && Character.isHighSurrogate(value.charAt(end - 1)) && Character.isLowSurrogate(value.charAt(end))) end--;
            chunks.add(value.substring(start, end)); start = end;
        }
        return chunks;
    }
    public static String join(Iterable<String> chunks) {
        StringBuilder value = new StringBuilder();
        for (String chunk : chunks) {
            if (chunk == null || chunk.length() > CHARACTERS || value.length() + chunk.length() > MAX_CHARACTERS) throw new IllegalArgumentException("Invalid offline item chunk");
            value.append(chunk);
        }
        return value.toString();
    }
}
