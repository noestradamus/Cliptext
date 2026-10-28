import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import life.cliptext.save.VideoUrlParser;

/** Test-only stdin/stdout adapter; does not read credentials or use Android. */
public final class UrlNormalizationProbe {
    public static void main(String[] args) throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
            String normalized = VideoUrlParser.extract(new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8));
            System.out.println(normalized == null ? "-" : Base64.getEncoder().encodeToString(normalized.getBytes(StandardCharsets.UTF_8)));
        }
    }
}
