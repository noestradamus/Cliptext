package life.cliptext.save;

import org.junit.Test;
import static org.junit.Assert.*;

public class QueuePolicyTest {
    @Test public void retriesAreBoundedAndIncrease() {
        assertEquals(30_000L, QueuePolicy.retryDelayMillis(0));
        assertEquals(60_000L, QueuePolicy.retryDelayMillis(1));
        assertEquals(6L * 60L * 60L * 1000L, QueuePolicy.retryDelayMillis(100));
    }
    @Test public void expiredAuthenticationRetainsQueueForReconnect() {
        assertTrue(QueuePolicy.needsConnection(401)); assertTrue(QueuePolicy.needsConnection(403)); assertTrue(QueuePolicy.needsConnection(302));
        assertFalse(QueuePolicy.permanentlyInvalid(401)); assertFalse(QueuePolicy.permanentlyInvalid(503));
    }
    @Test public void invalidLinkIsDistinctFromTemporaryFailure() {
        assertTrue(QueuePolicy.permanentlyInvalid(400)); assertTrue(QueuePolicy.permanentlyInvalid(422));
        assertFalse(QueuePolicy.permanentlyInvalid(429));
    }
}
