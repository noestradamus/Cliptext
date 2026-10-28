package life.cliptext.save;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class CacheChunksTest {
    @Test public void roundTripsLargeMultibyteItem() {
        StringBuilder text = new StringBuilder(); for (int i = 0; i < 600000; i++) text.append("雪😀");
        String original = text.toString(); assertTrue(original.getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024);
        List<String> chunks = CacheChunks.split(original); assertTrue(chunks.size() > 1);
        for (String chunk : chunks) { assertTrue(chunk.getBytes(StandardCharsets.UTF_8).length < 128 * 1024); assertFalse(Character.isHighSurrogate(chunk.charAt(chunk.length() - 1))); }
        assertEquals(original, CacheChunks.join(chunks));
    }
    @Test public void preservesBoundarySurrogatePair() {
        StringBuilder text = new StringBuilder(); for (int i = 0; i < CacheChunks.CHARACTERS - 1; i++) text.append('a'); text.append("😀z");
        List<String> chunks = CacheChunks.split(text.toString()); assertEquals(CacheChunks.CHARACTERS - 1, chunks.get(0).length()); assertEquals(text.toString(), CacheChunks.join(chunks));
    }
}
