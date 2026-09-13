package Display;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.swing.SwingUtilities;

/**
 * Lightweight helper to run background tasks and show an indeterminate
 * progress indicator if they exceed a small threshold.
 */
public class AsyncTask {
    private static final ExecutorService EXEC = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r);
        t.setDaemon(true);
        return t;
    });
    private static final ScheduledExecutorService SCHED = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r);
        t.setDaemon(true);
        return t;
    });

    public static void runWithProgress(Screen owner, Runnable bgTask) {
        runWithProgress(owner, () -> {
            bgTask.run();
            return null;
        });
    }

    public static <T> T runWithProgress(Screen owner, Callable<T> task) {
        Future<T> fut = EXEC.submit(() -> task.call());
        try {
            return fut.get();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
