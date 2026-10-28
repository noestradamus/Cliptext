package life.cliptext.save;

public final class QueuePolicy {
    public static final int MAX_PENDING = 1000;
    public static final int MAX_BATCH = 12;
    private QueuePolicy() { }
    public static long retryDelayMillis(int previousAttempts) {
        int exponent = Math.min(10, Math.max(0, previousAttempts));
        return Math.min(6L * 60L * 60L * 1000L, 30_000L * (1L << exponent));
    }
    public static boolean needsConnection(int httpStatus) {
        return httpStatus == 401 || httpStatus == 403 || (httpStatus >= 300 && httpStatus < 400);
    }
    public static boolean permanentlyInvalid(int httpStatus) { return httpStatus == 400 || httpStatus == 422; }
}
