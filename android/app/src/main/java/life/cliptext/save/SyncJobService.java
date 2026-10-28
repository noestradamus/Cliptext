package life.cliptext.save;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SyncJobService extends JobService {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile Run active;
    private static final class Run {
        final JobParameters parameters;
        final LocalApi.Cancellation cancel = new LocalApi.Cancellation();
        Run(JobParameters parameters) { this.parameters = parameters; }
    }
    @Override public boolean onStartJob(JobParameters parameters) {
        Run previous = active; if (previous != null) previous.cancel.cancel();
        final Run run = new Run(parameters); active = run;
        executor.execute(() -> {
            SyncRunner.Result result = SyncRunner.run(getApplicationContext(), run.cancel, false);
            new Handler(Looper.getMainLooper()).post(() -> {
                if (active != run || run.cancel.cancelled()) return;
                active = null; jobFinished(parameters, false);
                if (result == SyncRunner.Result.MORE) SyncScheduler.soon(SyncJobService.this, 10_000);
                else if (result == SyncRunner.Result.WAITING) SyncScheduler.soon(SyncJobService.this, 15 * 60_000L);
            });
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters parameters) {
        Run run = active;
        if (run != null && run.parameters.getJobId() == parameters.getJobId()) { active = null; run.cancel.cancel(); }
        return true;
    }
    @Override public void onDestroy() { Run run = active; if (run != null) run.cancel.cancel(); active = null; executor.shutdownNow(); super.onDestroy(); }
}
