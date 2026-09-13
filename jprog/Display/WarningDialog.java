package Display;

import java.util.logging.Level;
import javax.swing.JOptionPane;

/**
 * Similar to Error Dialog, but allows more freedom in what to do after the
 * error and allows it to be automatically fixed and continue the application's
 * normal operations
 * The returning to a normal state must be implemented each time
 * 
 * @see Returnable
 * @see ErrorDialog
 */
public class WarningDialog extends JOptionPane {
    public WarningDialog(Throwable throwable, Returnable returnTo) {
        this(throwable, "", returnTo);
    }

    public WarningDialog(Throwable throwable, String text, Returnable returnTo) {
        if (returnTo != null) {
            returnTo.returnTo();
        }
        Screen.logger.log(Level.WARNING, text + "\n" + throwable.getMessage(), throwable);
        showMessageDialog(Screen.screen, text,
                "Warning: "
                        + throwable.getClass().getName().substring(throwable.getClass().getName().lastIndexOf('.') + 1),
                JOptionPane.WARNING_MESSAGE);
        repaint();
        invalidate();
        setVisible(false);
        Screen.screen.repaint();
    }

    public WarningDialog() {
        super();
    }

    public int createYesOrNoWarningDialog(String text, String title) {
        return showConfirmDialog(Screen.screen, text, title, OK_CANCEL_OPTION, WARNING_MESSAGE);
    }
}
