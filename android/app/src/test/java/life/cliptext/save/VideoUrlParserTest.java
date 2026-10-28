package life.cliptext.save;

import org.junit.Test;
import static org.junit.Assert.*;

public class VideoUrlParserTest {
    private static final String YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    private static final String REEL = "https://www.instagram.com/reel/Cx_12-ab/";

    @Test public void normalizesTiktokPhotoPostsAcrossAllowedHosts() {
        for (String host : new String[]{"tiktok.com", "www.tiktok.com", "m.tiktok.com"}) {
            String value = "https://" + host + "/@sample_creator/photo/1234567890123456789";
            assertEquals(value, VideoUrlParser.normalize(value + "?photo_index=2&is_from_webapp=1"));
            assertEquals(value, VideoUrlParser.normalize(VideoUrlParser.normalize(value)));
        }
    }
    @Test public void extractsPhotoShareTextAndLegacyParserAcceptsIt() {
        String value = "https://www.tiktok.com/@sample_creator/photo/1234567890123456789";
        assertEquals(value, VideoUrlParser.extract("Look at these photos " + value + "?photo_index=2)."));
        assertEquals(value, TikTokUrlParser.extract(value));
        assertEquals(value, VideoUrlParser.extract("Photo post", value));
    }
    @Test public void photoSupportPreservesHostAndPathBoundaries() {
        String[] inputs = {
            "https://www.tiktok.com.evil.test/@user/photo/1234567890123456789",
            "https://user@www.tiktok.com/@user/photo/1234567890123456789",
            "https://www.tiktok.com:444/@user/photo/1234567890123456789",
            "https://www.tiktok.com/@user/photo/123",
            "https://www.tiktok.com/@user/photo/1234567890123456789/extra",
            "https://www.tiktok.com/@user/photo/1234567890123456789/%2e",
            "https://www.tiktok.com/@user/photos/1234567890123456789",
            "https://www.tiktok.com/a/../@user/photo/1234567890123456789"
        };
        for (String input : inputs) assertNull(input, VideoUrlParser.normalize(input));
    }

    @Test public void normalizesYoutubeWatchShortsAndShareLinks() {
        String[] inputs = {"https://youtu.be/dQw4w9WgXcQ?si=track", "https://www.youtu.be/dQw4w9WgXcQ/", "https://youtube.com/watch?v=dQw4w9WgXcQ&t=30", "https://www.youtube.com/watch/?v=dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share"};
        for (String input : inputs) assertEquals(input, YOUTUBE, VideoUrlParser.normalize(input));
    }
    @Test public void requiresExactlyOneDecodedYoutubeVideoId() {
        assertEquals(YOUTUBE, VideoUrlParser.normalize("https://youtube.com/watch?%76=%64Qw4w9WgXcQ"));
        String[] inputs = {"https://youtube.com/watch", "https://youtube.com/watch?v=dQw4w9WgXc", "https://youtube.com/watch?v=dQw4w9WgXcQQ", "https://youtube.com/watch?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ", "https://youtube.com/watch?v=dQw4w9WgXcQ&%76=abcdefghijk"};
        for (String input : inputs) assertNull(input, VideoUrlParser.normalize(input));
    }
    @Test public void normalizesInstagramReelsAndPostPermalinks() {
        for (String input : new String[]{"https://instagram.com/reels/Cx_12-ab?igsh=tracking", "https://m.instagram.com/reel/Cx_12-ab/", "https://WWW.INSTAGRAM.COM:443/reel/Cx_12-ab/#fragment"}) assertEquals(input, REEL, VideoUrlParser.normalize(input));
        assertEquals("https://www.instagram.com/p/Cx_12-ab/", VideoUrlParser.normalize("https://instagram.com/p/Cx_12-ab?img_index=2"));
    }
    @Test public void rejectsProfilesPlaylistsStoriesAndUnsupportedVideoForms() {
        String[] inputs = {"https://youtube.com/playlist?list=abc", "https://youtube.com/@channel", "https://youtube.com/embed/dQw4w9WgXcQ", "https://youtube.com/live/dQw4w9WgXcQ", "https://music.youtube.com/watch?v=dQw4w9WgXcQ", "https://instagram.com/profile/", "https://instagram.com/stories/name/123/", "https://instagram.com/reels/", "https://instagram.com/reel/abcd/", "https://instagram.com/reel/Cx_12-ab/extra"};
        for (String input : inputs) assertNull(input, VideoUrlParser.normalize(input));
    }
    @Test public void rejectsCredentialsPortsLookalikesAndTraversal() {
        String[] inputs = {"http://youtu.be/dQw4w9WgXcQ", "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ", "https://@youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com:444/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com/a/%2e%2e/shorts/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ/.", "https://instagram.com/reel/Cx_12-ab/%2e", "https:////youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com\\watch?v=dQw4w9WgXcQ"};
        for (String input : inputs) assertNull(input, VideoUrlParser.normalize(input));
    }
    @Test public void extractsSharedTextAndRetainsExistingTiktokLinks() {
        assertEquals(YOUTUBE, VideoUrlParser.extract("Watch https://example.test then https://youtu.be/dQw4w9WgXcQ)."));
        assertEquals(REEL, VideoUrlParser.extract("Check this https://instagram.com/reels/Cx_12-ab/。"));
        assertEquals("https://vt.tiktok.com/AbCdEfGh1/", VideoUrlParser.extract("https://vt.tiktok.com/AbCdEfGh1/?_t=tracking"));
        assertNull(VideoUrlParser.extract("https://evil.test/?redirect=https://youtu.be/dQw4w9WgXcQ"));
    }
    @Test public void canonicalResultsRemainStable() {
        for (String value : new String[]{YOUTUBE, REEL, "https://www.instagram.com/p/Cx_12-ab/", "https://vt.tiktok.com/AbCdEfGh1/"}) assertEquals(value, VideoUrlParser.normalize(VideoUrlParser.normalize(value)));
    }
    @Test public void boundsInputAndRejectsMalformedEscapes() {
        assertNull(VideoUrlParser.normalize("https://youtube.com/watch?v=dQw4w9WgXcQ&tracking=%zz"));
        StringBuilder huge = new StringBuilder("https://instagram.com/reel/");
        while (huge.length() < 2100) huge.append('a');
        assertNull(VideoUrlParser.normalize(huge.toString()));
    }
}
