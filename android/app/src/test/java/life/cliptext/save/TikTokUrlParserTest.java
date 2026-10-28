package life.cliptext.save;

import org.junit.Test;
import static org.junit.Assert.*;

public class TikTokUrlParserTest {
    @Test public void extractsAndroidShareText() {
        assertEquals("https://vt.tiktok.com/AbCdEfGh1/", TikTokUrlParser.extract("Watch this 👀 https://vt.tiktok.com/AbCdEfGh1/"));
    }
    @Test public void usesSubjectWhenTextHasNoLink() {
        assertEquals("https://www.tiktok.com/@sample_creator/video/1234567890123456789", TikTokUrlParser.extract("A useful video", "https://www.tiktok.com/@sample_creator/video/1234567890123456789"));
    }
    @Test public void ignoresOtherLinksAndTrailingPunctuation() {
        assertEquals("https://vm.tiktok.com/abcd/", TikTokUrlParser.extract("https://example.com then https://vm.tiktok.com/abcd/)."));
    }
    @Test public void rejectsCredentialPortsLookalikesAndNonHttps() {
        String[] invalid = {"https://tiktok.com.evil.invalid/x", "https://user:password@www.tiktok.com/x", "https://www.tiktok.com:444/x", "http://vt.tiktok.com/x", "file:///tmp/video", "https://tiktok.com/"};
        for (String url : invalid) assertFalse(url, TikTokUrlParser.isAllowed(url));
    }
    @Test public void doesNotAcceptUnboundedInput() {
        StringBuilder builder = new StringBuilder("https://vt.tiktok.com/");
        while (builder.length() < 2100) builder.append('a');
        assertFalse(TikTokUrlParser.isAllowed(builder.toString()));
    }
    @Test public void stripsTrackingQueryAndFragment() {
        assertEquals("https://www.tiktok.com/@sample_creator/video/1234567890123456789/", TikTokUrlParser.extract("https://WWW.TIKTOK.COM:443/@sample_creator/video/1234567890123456789/?_t=tracking#fragment"));
    }
    @Test public void rejectsProfilesAndRawOrEncodedTraversal() {
        String[] invalid = {"https://www.tiktok.com/@sample_creator", "https://www.tiktok.com/anything", "https://www.tiktok.com/x/../@user/video/1234567890123456789", "https://www.tiktok.com/x/%2e%2e/@user/video/1234567890123456789", "https://vt.tiktok.com/abc/"};
        for (String url : invalid) assertFalse(url, TikTokUrlParser.isAllowed(url));
    }
}
