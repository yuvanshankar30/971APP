package Display;

import java.awt.Component;
import java.awt.Container;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Collections;

import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextField;
import javax.swing.Spring;
import javax.swing.SpringLayout;

import SheetHandler.Settings;

public class SettingsPanel extends JPanel {
    private HashMap<JTextField, String> map = new HashMap<>();

    public SettingsPanel() {
        setup();
    }

    public void setup() {
        // clears all previous components
        removeAll();
        map.clear();
        setLayout(new SpringLayout());

        int count = 0;
        ArrayList<String> iteratorList = new ArrayList<>(Settings.settings.keySet());
        Collections.sort(iteratorList);
        // makes compact grid of each setting name and a JTextField for each value and
        // put in its current one
        for (String key : iteratorList) {
            JLabel temp = new JLabel(key, JLabel.TRAILING);
            add(temp);
            JTextField temp2 = new JTextField(10);
            temp2.setText(Settings.settings.get(key));
            temp.setLabelFor(temp2);
            add(temp2);
            map.put(temp2, key);
            count++;
        }

        makeCompactGrid(this, count, 2, 6, 6, 6, 6);
    }

    // Allows grid of jlabels and jtextfields with associated keys and values to the
    // hashmap in settings
    public static void makeCompactGrid(Container parent, int rows, int cols, int initialX, int initialY, int xPad,
            int yPad) {
        SpringLayout layout;
        try {
            layout = (SpringLayout) parent.getLayout();
        } catch (ClassCastException exc) {
            new ErrorDialog(exc);
            return;
        }

        // Align all cells in each column and make them the same width.
        Spring x = Spring.constant(initialX);
        for (int c = 0; c < cols; c++) {
            Spring width = Spring.constant(0);
            for (int r = 0; r < rows; r++) {
                width = Spring.max(width,
                        getConstraintsForCell(r, c, parent, cols).getWidth());
            }
            for (int r = 0; r < rows; r++) {
                SpringLayout.Constraints constraints = getConstraintsForCell(r, c, parent, cols);
                constraints.setX(x);
                constraints.setWidth(width);
            }
            x = Spring.sum(x, Spring.sum(width, Spring.constant(xPad)));
        }

        // Align all cells in each row and make them the same height.
        Spring y = Spring.constant(initialY);
        for (int r = 0; r < rows; r++) {
            Spring height = Spring.constant(0);
            for (int c = 0; c < cols; c++) {
                height = Spring.max(height,
                        getConstraintsForCell(r, c, parent, cols).getHeight());
            }
            for (int c = 0; c < cols; c++) {
                SpringLayout.Constraints constraints = getConstraintsForCell(r, c, parent, cols);
                constraints.setY(y);
                constraints.setHeight(height);
            }
            y = Spring.sum(y, Spring.sum(height, Spring.constant(yPad)));
        }

        // Set the parent's size.
        SpringLayout.Constraints pCons = layout.getConstraints(parent);
        pCons.setConstraint(SpringLayout.SOUTH, y);
        pCons.setConstraint(SpringLayout.EAST, x);
    }

    private static SpringLayout.Constraints getConstraintsForCell(
            int row, int col,
            Container parent,
            int cols) {
        SpringLayout layout = (SpringLayout) parent.getLayout();
        Component c = parent.getComponent(row * cols + col);
        return layout.getConstraints(c);
    }

    // saves puts all the field into the Hashmap of the settings and saves it to the
    // file
    public void save() {
        for (JTextField field : map.keySet()) {
            Settings.settings.put(map.get(field), field.getText());
        }
        Settings.settings.saveFile();
    }

    // saves the file each time we switch to/from the settings menu
    @Override
    public void setVisible(boolean aFlag) {
        save();
        super.setVisible(aFlag);
    }
}
