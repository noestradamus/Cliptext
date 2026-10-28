package life.cliptext.save;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;

public final class SyncScheduler {
    private static final int SOON = 27111, PERIODIC = 27112;
    private SyncScheduler() { }
    public static void ensurePeriodic(Context context) {
        JobScheduler jobs = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE); if (jobs == null) return;
        // Cancel the retired Site upload/receipt jobs during an in-place update.
        jobs.cancel(27101); jobs.cancel(27102); jobs.cancel(27103);
        if (jobs.getPendingJob(PERIODIC) == null) jobs.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(context, SyncJobService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15 * 60_000L).setPersisted(true).build());
    }
    public static void soon(Context context, long delay) {
        ensurePeriodic(context);
        JobScheduler jobs = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE); if (jobs == null) return;
        jobs.schedule(new JobInfo.Builder(SOON, new ComponentName(context, SyncJobService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(Math.max(0, delay)).setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).setPersisted(true).build());
    }
}
