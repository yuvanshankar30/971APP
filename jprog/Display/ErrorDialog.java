package Display;

import java.util.logging.Level;
import javax.swing.JOptionPane;

/**
 * This class creates Error Dialogs that show throwable.getMessage() and close
 * the application after
 */
public class ErrorDialog extends JOptionPane {
    public ErrorDialog(Throwable throwable) {
        showMessageDialog(Screen.screen, throwable.getMessage(),
                "Fatal Error: "
                        + throwable.getClass().getName().substring(throwable.getClass().getName().lastIndexOf('.') + 1),
                JOptionPane.ERROR_MESSAGE);
        Screen.logger.log(Level.SEVERE, throwable.getMessage(), throwable);
        System.exit(-1);
    }

    public ErrorDialog(Throwable throwable, String text) {
        showMessageDialog(Screen.screen, text,
                "Fatal Error: "
                        + throwable.getClass().getName().substring(throwable.getClass().getName().lastIndexOf('.') + 1),
                JOptionPane.ERROR_MESSAGE);
        Screen.logger.log(Level.SEVERE, text + "\n" + throwable.getMessage(), throwable);
        System.exit(-1);
    }
}
