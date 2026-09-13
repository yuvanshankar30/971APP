import Display.*;
import SheetHandler.Settings;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.PrintStream;
import javax.imageio.ImageIO;
import javax.swing.JFrame;
import javax.swing.UIManager;
import javax.swing.SwingUtilities;

public class JustinProg {
    public static void main(String[] args) {
        try {
    		if (Screen.DebugMode)
        		System.setOut(new PrintStream(new File("debugOut.log")));
    		UIManager.setLookAndFeel("javax.swing.plaf.nimbus.NimbusLookAndFeel");
	} catch (FileNotFoundException e) {
            System.out.println("debugOut.log cannot be found or created");
        } catch (Exception e) {
            System.out.println("Thee should  not  changeth  the  behold  and  feeleth");
        }
        BufferedImage iconImage = null;
        try {
            iconImage = ImageIO.read(new File(Settings.settings.get("IconImageFile")));
        } catch (IOException e) {
            System.err.println("No icon image found");
        }

        final BufferedImage appIcon = iconImage;
        SwingUtilities.invokeLater(() -> {
            final Screen screen = new Screen();
            final JFrame frame = new JFrame("Justin Prog");

            frame.add(screen);

            frame.pack();
            if (appIcon != null) {
                frame.setIconImage(appIcon);
            }
            frame.setVisible(true);
            // sets window on top but not always
            frame.setAlwaysOnTop(true);
            frame.setAlwaysOnTop(false);
            frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
            frame.addWindowListener(new java.awt.event.WindowAdapter() {
                @Override
                public void windowClosing(java.awt.event.WindowEvent e) {
                    int confirm = javax.swing.JOptionPane.showConfirmDialog(
                            frame,
                            "Are you sure you want to close? Unsaved changes will be lost.",
                            "Close",
                            javax.swing.JOptionPane.YES_NO_OPTION);
                    if (confirm == javax.swing.JOptionPane.YES_OPTION) {
                        System.exit(0);
                    }
                }
            });
        });
    }
}