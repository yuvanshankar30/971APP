package Display;

import static Display.Screen.SheetMenuState.*;

import Parser.GCode.NGCDocument;
import Parser.GCode.NgcStrain;
import SheetHandler.Cut;
import SheetHandler.Hole;
import SheetHandler.Part;
import SheetHandler.Settings;
import SheetHandler.Sheet;
import SheetHandler.SheetThickness;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.GridLayout;
import java.awt.Insets;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.datatransfer.Transferable;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.ItemEvent;
import java.awt.event.ItemListener;
import java.awt.event.MouseEvent;
import java.awt.event.MouseWheelEvent;
import java.awt.event.MouseWheelListener;
import java.awt.geom.AffineTransform;
import java.awt.geom.Point2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.lang.Thread.UncaughtExceptionHandler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.logging.FileHandler;
import java.util.logging.Logger;
import java.util.logging.SimpleFormatter;
import javax.imageio.ImageIO;
import javax.swing.AbstractAction;
import javax.swing.BorderFactory;
import javax.swing.ButtonGroup;
import javax.swing.DefaultListModel;
import javax.swing.DropMode;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JOptionPane;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextField;
import javax.swing.KeyStroke;
import javax.swing.SwingUtilities;
import javax.swing.TransferHandler;
import javax.swing.event.ListSelectionEvent;
import javax.swing.event.ListSelectionListener;
import javax.swing.event.MouseInputListener;
import java.awt.Font;

public class Screen extends JPanel
        implements MouseWheelListener,
        MouseInputListener,
        ActionListener,
        ListSelectionListener,
        ItemListener {
    private static final Color PANEL_BACKGROUND = new Color(25,25,25);

    public static Screen screen;
    public static final boolean DebugMode = Boolean.parseBoolean(Settings.settings.get("DebugMode"));
    private JList<File> sheetList;
    private JScrollPane sheetScroll;
    private DefaultListModel<File> sheetFileList;
    private JTextField sheetSearch;
    private File sheetsParent;
    private JButton addSheet;
    private JButton selectSheet;
    private JButton returnToHome;
    private JLabel sheetName;
    private Sheet selectedSheet;
    private State state;
    private double xCorner = 0;
    private double yCorner = 0;
    private double zoom = 20;
    private double startX; // for panning
    private double startY;
    private boolean panning = false;
    private boolean draggingPart = false;
    private boolean rotatingPart = false;
    private boolean ctrlPressed = false;
    private Point2D rotationPoint;
    private Part partBeingDragged;
    private double partGrabbedX;
    private double partGrabbedY;
    private double partGrabbedInitialRot;
    private double partGrabbedInitialX;
    private double partGrabbedInitialY;
    private NewSheetPrompt newSheetPrompt;
    private ArrayList<BufferedImage> imgs = new ArrayList<>();
    private ArrayList<EditAction> undoList;
    private ArrayList<EditAction> redoList;
    private AbstractAction undo;
    private AbstractAction redo;
    private AbstractAction deleteSelected;
    private AbstractAction saveSheet;
    private JButton addHole;
    private JButton addItem;
    private JButton del;
    private JButton reScan;
    private JButton emit;
    private JButton save;
    private JButton undoButton;
    private JButton redoButton;
    private JButton addCut;
    private JButton measure;
    private JButton changeCut;
    private JLabel cutName;
    private JButton changeGCodeView;
    private Part selectedPart = null;
    private Point2D.Double measurePoint1;
    private Point2D.Double measurePoint2;
    private SheetMenuState menuState = NULL;
    private ArrayList<JPanel> menuPanels = new ArrayList<>();
    private SheetEditMenu editMenu;
    private boolean specialDetect = false;
    private JPanel cutPanel;
    private JPanel gcodeCutPanel;
    private ItemSelectMenu itemSelectMenu;
    private EmitSelect emitPanel;
    private JButton[] suffixes;
    private JPanel gcodePartPanel;
    private JPanel newcutPanel;
    private ReturnToHomeJButton returnToHomeMenu;
    private ReturnOnceJButton returnOnce;
    public static Logger logger;
    private JTextField newCutField;
    private JButton newCutButton;
    private boolean aHeld;
    private JButton theButton = new JButton();
    private SettingsPanel settingsPanel = new SettingsPanel();
    private JButton returnToHomeFromSettings = new JButton();
    private JButton toSettings = new JButton();
    private JButton resetToDefault = new JButton();
    private JButton restartApplication = new JButton();

    static {
        if (DebugMode)
            System.out.println("Welcome to Debug Mode!");
        // setups logger
        logger = Logger.getLogger("MyLog");
        FileHandler fh;
        try {
            // creates logger file and set format
            fh = new FileHandler(Settings.settings.get("LoggerFile"), true);
            logger.addHandler(fh);
            fh.setFormatter(new SimpleFormatter());
        } catch (SecurityException | IOException e) {
            e.printStackTrace();
        }
        logger.setUseParentHandlers(DebugMode);
    }

    public Screen() {
        screen = this;
        setLayout(null);
        setOpaque(true);
        setBackground(PANEL_BACKGROUND);
        state = State.SHEET_SELECT;

        sheetsParent = new File(Settings.settings.get("SheetParentFolder"));
        sheetFileList = new DefaultListModel<>();

        // sets uncaught errors during operation to create an error dialog
        Thread.setDefaultUncaughtExceptionHandler(
                new UncaughtExceptionHandler() {
                    @Override
                    public void uncaughtException(Thread t, Throwable e) {
                        new ErrorDialog(e);
                    }
                });

        sheetList = new JList<File>(sheetFileList);
        sheetScroll = new JScrollPane(sheetList);
        sheetScroll.setBounds(100, 130, 225, 570);
        add(sheetScroll);
        sheetList.addListSelectionListener(this);

        sheetSearch = new JTextField();
        sheetSearch.setBounds(100, 100, 225, 28);
        sheetSearch.setToolTipText("Search sheets...");
        add(sheetSearch);
        sheetSearch.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            private void filter() {
                applySheetSearchFilter();
            }
            public void insertUpdate(javax.swing.event.DocumentEvent e) { filter(); }
            public void removeUpdate(javax.swing.event.DocumentEvent e) { filter(); }
            public void changedUpdate(javax.swing.event.DocumentEvent e) { filter(); }
        });
        refreshSheetFileListAsync();

        returnToHome = new JButton("Return to Home");
        // returnToHome.setBounds(0, 0, 150, 45);
        // add(returnToHome);
        returnToHome.addActionListener(this);
        // returnToHome.setVisible(false);

        addSheet = new JButton("Add new sheet");
        addSheet.setBounds(350, 100, 200, 50);
        add(addSheet);
        addSheet.addActionListener(this);

        selectSheet = new JButton("Select sheet");
        selectSheet.setBounds(350, 200, 200, 50);
        add(selectSheet);
        selectSheet.addActionListener(this);
        selectSheet.setEnabled(false);

        newSheetPrompt = new NewSheetPrompt(this);
        newSheetPrompt.setVisible(false);
        newSheetPrompt.setAlwaysOnTop(true);

        editMenu = new SheetEditMenu();
        add(editMenu);
        menuPanels.add(editMenu);

        newcutPanel = new NewCutMenu();
        add(newcutPanel);
        newcutPanel.setVisible(false);
        newcutPanel.setBounds(editMenu.getBounds());
        menuPanels.add(newcutPanel);

        theButton.setBounds(0, 0, 5, 5);
        add(theButton);
        theButton.setOpaque(false);
        theButton.setContentAreaFilled(false);
        theButton.setBorderPainted(false);
        theButton.addActionListener(this);

        add(settingsPanel);
        settingsPanel.setBounds(300, 100, 600, 600);
        settingsPanel.setVisible(false);

        add(returnToHomeFromSettings);
        returnToHomeFromSettings.setAction(
                new AbstractAction() {
                    @Override
                    public void actionPerformed(ActionEvent e) {
                        settingsPanel.save();
                        switchStates(State.SHEET_SELECT);
                    }
                });
        returnToHomeFromSettings.setText("Return");
        returnToHomeFromSettings.setBounds(700, 0, 200, 100);
        returnToHomeFromSettings.setVisible(false);

        add(resetToDefault);
        resetToDefault.setAction(
                new AbstractAction() {
                    @Override
                    public void actionPerformed(ActionEvent e) {
                        Settings.settings.resetToDefault();
                        settingsPanel.revalidate();
                        settingsPanel.setup();
                    }
                });
        resetToDefault.setText("Reset to Default");
        resetToDefault.setBounds(300, 0, 400, 100);
        resetToDefault.setVisible(false);

        add(restartApplication);
        restartApplication.setAction(
                new AbstractAction() {
                    @Override
                    public void actionPerformed(ActionEvent e) {
                        settingsPanel.save();
                        System.exit(-2);
                    }
                });
        restartApplication.setText("Apply Settings(Restart Application)");
        restartApplication.setBounds(400, 700 + 40 / 2, 400, 60);
        restartApplication.setVisible(false);

        add(toSettings);
        toSettings.setBounds(1200 - 52, 3, 50, 50);
        toSettings.setAction(
                new AbstractAction() {
                    @Override
                    public void actionPerformed(ActionEvent e) {
                        switchStates(State.SETTINGS);
                    }
                });
        // Load settings icons off the EDT to avoid blocking UI construction
        new Thread(() -> {
            try {
                BufferedImage img = ImageIO.read(new File(Settings.settings.get("SettingsIconImage")));
                BufferedImage img2 = ImageIO.read(new File(Settings.settings.get("SettingsIconImage2")));
                if (img != null && img2 != null) {
                    SwingUtilities.invokeLater(() -> {
                        toSettings.setIcon(new ImageIcon(img2));
                        toSettings.setRolloverIcon(new ImageIcon(img));
                        toSettings.setPressedIcon(new ImageIcon(img));
                        toSettings.setBackground(PANEL_BACKGROUND);
                        toSettings.setBorderPainted(false);
                        toSettings.setContentAreaFilled(false);
                        toSettings.setFocusPainted(false);
                        toSettings.setOpaque(false);
                    });
                } else {
                    SwingUtilities.invokeLater(() -> {
                        toSettings.setText("Settings");
                        toSettings.setBounds(1200 - 200, 0, 200, 50);
                    });
                }
            } catch (IOException e) {
                SwingUtilities.invokeLater(() -> {
                    toSettings.setText("Settings");
                    toSettings.setBounds(1200 - 200, 0, 200, 50);
                });
            }
        }, "settings-icon-loader").start();

        returnToHomeMenu = new ReturnToHomeJButton("Return to Home");
        returnToHomeMenu.addActionListener(this);

        returnOnce = new ReturnOnceJButton("Return");
        returnOnce.addActionListener(this);

        itemSelectMenu = new ItemSelectMenu();
        add(itemSelectMenu);
        itemSelectMenu.setVisible(false);
        itemSelectMenu.setBounds(editMenu.getBounds());
        menuPanels.add(itemSelectMenu);

        // Load display images asynchronously to avoid blocking the UI thread
        new Thread(() -> {
            try {
                File displayDir = new File("Display");
                File[] files = displayDir.listFiles();
                if (files != null) {
                    for (File file : files) {
                        String name = file.getName();
                        int idx = name.lastIndexOf('.');
                        if (idx >= 0 && name.substring(idx + 1).equals("jav")) {
                            try {
                                BufferedImage img = ImageIO.read(file);
                                if (img != null) {
                                    imgs.add(img);
                                    SwingUtilities.invokeLater(() -> repaint());
                                }
                            } catch (IOException ignore) {
                            }
                        }
                    }
                }
            } catch (NullPointerException e) {
                System.err.println("Logo not Found");
            }
        }, "display-image-loader").start();

        // resizes all menu JPanels when frame is resized
        addComponentListener(
                new ComponentAdapter() {
                    @Override
                    public void componentResized(ComponentEvent e) {
                        menuPanels.stream().forEach(j -> j.setBounds(0, 0, 400, e.getComponent().getHeight()));
                    }
                });

        addMouseListener(this);
        addMouseMotionListener(this);
        addMouseWheelListener(this);

        setFocusable(true);
        requestFocus();

        undoList = new ArrayList<>();
        redoList = new ArrayList<>();

        undo = new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                if (undoList.size() > 0) {
                    EditAction action = undoList.get(undoList.size() - 1);
                    action.undoAction(selectedSheet);
                    undoList.remove(action);
                    redoList.add(action);
                    if (!action.doesSomething()) {
                        this.actionPerformed(e);
                    }
                    repaint();
                }
            }
        };

        redo = new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                if (redoList.size() > 0) {
                    EditAction action = redoList.get(redoList.size() - 1);
                    action.redoAction(selectedSheet);
                    redoList.remove(action);
                    undoList.add(action);
                    if (!action.doesSomething()) {
                        this.actionPerformed(e);
                    }
                    repaint();
                }
            }
        };

        deleteSelected = new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                if (selectedPart != null) {
                    // correct for deleting and moving a part at the same time
                    if (selectedPart == partBeingDragged) {
                        undoList.add(
                                new EditAction(
                                        partBeingDragged,
                                        partGrabbedInitialX,
                                        partGrabbedInitialY,
                                        partGrabbedInitialRot));
                        draggingPart = false;
                        partBeingDragged = null;
                    }
                    redoList.clear();
                    selectedSheet.removePart(selectedPart);
                    undoList.add(new EditAction(selectedPart, false));
                    repaint();
                }
            }
        };

        saveSheet = new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent e) {
                if (selectedSheet != null) {
                    selectedSheet.saveToFile();
                }
            }
        };

        // sets keybinds(key strokes to actions, actions to Code)
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("control Z"), "undo");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("control Y"), "redo");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("control S"), "save");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("DELETE"), "delete");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(KeyStroke.getKeyStroke("BACK_SPACE"), "delete");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(KeyStroke.getKeyStroke("A"), "placement mode on");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(KeyStroke.getKeyStroke("released A"), "placement mode off");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(KeyStroke.getKeyStroke("control CONTROL"), "rotation mode on");
        getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(KeyStroke.getKeyStroke("released CONTROL"), "rotation mode off");

        getActionMap().put("undo", undo);
        getActionMap().put("redo", redo);
        getActionMap().put("delete", deleteSelected);
        getActionMap()
                .put(
                        "placement mode on",
                        new AbstractAction() {
                            @Override
                            public void actionPerformed(ActionEvent e) {
                                aHeld = true;
                            }
                        });

        getActionMap()
                .put(
                        "placement mode off",
                        new AbstractAction() {
                            @Override
                            public void actionPerformed(ActionEvent e) {
                                aHeld = false;
                            }
                        });

        getActionMap()
                .put(
                        "rotation mode on",
                        new AbstractAction() {
                            @Override
                            public void actionPerformed(ActionEvent e) {
                                ctrlPressed = true;
                            }
                        });

        getActionMap()
                .put(
                        "rotation mode off",
                        new AbstractAction() {
                            @Override
                            public void actionPerformed(ActionEvent e) {
                                ctrlPressed = false;
                                rotatingPart = false;
                                rotationPoint = null;
                            }
                        });

        menuPanels.stream()
                .forEach(
                        e -> {
                            e.setVisible(false);
                        });
    }

    /**
     * Set the status text in the edit menu buffer. Safe to call from any thread.
     */
    public void setStatusText(final String text) {
        SwingUtilities.invokeLater(() -> {
            if (editMenu != null && editMenu.buffer != null) {
                editMenu.buffer.setText(text);
            }
        });
    }

    @Override
    public Dimension getPreferredSize() {
        return new Dimension(1200, 800);
    }

    @Override
    public void paintComponent(Graphics g) {
        super.paintComponent(g);
        g.setColor(getBackground());
        g.fillRect(0, 0, getWidth(), getHeight());
        g.setColor(new Color(25,25,25));
        g.setFont(new Font("Arial", Font.BOLD, 55));
        g.drawString("Happy Birthday",250,50);
        // set all menu JPanels not visible
        measure.setForeground(menuState == MEASURE ? Color.LIGHT_GRAY : null);
        addHole.setForeground(menuState == ADD_HOLE ? Color.LIGHT_GRAY : null);
        switch (state) {
            case SHEET_SELECT -> {
                // g.drawImage(img, 300, 100, null);(background image)
            }
            case SHEET_EDIT -> {
                Graphics2D g2d = (Graphics2D) g;
                AffineTransform prevTransform = g2d.getTransform();
                g2d.scale(zoom, zoom);
                g2d.translate(xCorner, yCorner);
                g2d.setStroke(new BasicStroke((float) (1 / zoom)));
                selectedSheet.draw(g);
                g2d.setTransform(prevTransform);

                if (rotationPoint != null) {
                    g2d.setColor(Color.ORANGE);
                    Point2D rPnt = sheetToScreen(rotationPoint);
                    g2d.setStroke(new BasicStroke(2));
                    g2d.drawLine(
                            (int) rPnt.getX() - 5,
                            (int) rPnt.getY() - 5,
                            (int) rPnt.getX() + 5,
                            (int) rPnt.getY() + 5);
                    g2d.drawLine(
                            (int) rPnt.getX() - 5,
                            (int) rPnt.getY() + 5,
                            (int) rPnt.getX() + 5,
                            (int) rPnt.getY() - 5);
                }
                if (menuState == MEASURE) {
                    g2d.setColor(Color.YELLOW);
                    g2d.setStroke(new BasicStroke(2));
                    Point2D screenPoint1 = null;
                    Point2D screenPoint2 = null;
                    if (measurePoint1 != null) {
                        screenPoint1 = sheetToScreen(measurePoint1);
                        g2d.fillOval((int) screenPoint1.getX() - 5, (int) screenPoint1.getY() - 5, 10, 10);
                    }
                    if (measurePoint2 != null) {
                        screenPoint2 = sheetToScreen(measurePoint2);
                        g2d.fillOval((int) screenPoint2.getX() - 5, (int) screenPoint2.getY() - 5, 10, 10);
                    }
                    if (measurePoint1 != null && measurePoint2 != null) {
                        g2d.drawLine(
                                (int) screenPoint1.getX(), (int) screenPoint1.getY(),
                                (int) screenPoint2.getX(), (int) screenPoint2.getY());
                        g2d.drawString(
                                String.format("%.3f\"", measurePoint1.distance(measurePoint2)),
                                (int) (screenPoint1.getX() / 2 + screenPoint2.getX() / 2 + 10),
                                (int) (screenPoint1.getY() / 2 + screenPoint2.getY() / 2 - 10));
                    }
                }
                try {
                    switch (menuState) {
                        case HOME, MEASURE -> {
                            editMenu.setVisible(true);
                            editMenu.hideAMessage();
                        }
                        case CUT_SELECT -> {
                            cutPanel.setVisible(true);
                        }
                        case GCODE_SELECT -> gcodeCutPanel.setVisible(true);
                        case GCODE_SELECT_PART -> gcodePartPanel.setVisible(true);
                        case EMIT_SELECT -> {
                            if (!emitPanel.isVisible())
                                emitPanel.setVisible(true);
                        }
                        case ADD_CUT -> {
                            newcutPanel.setVisible(true);
                        }
                        case ADD_HOLE -> {
                            editMenu.setVisible(true);
                            editMenu.showAMessage();
                        }
                        case ADD_ITEM -> {
                            itemSelectMenu.setVisible(true);
                        }
                        default -> {
                        }
                    }
                } catch (NullPointerException e) {
                    new WarningDialog(e, "No Active Cut", () -> switchMenuStates(HOME));
                }
                // revalidate each invalid JPanel
                menuPanels.stream().filter(e -> !e.isValid()).forEach(e -> e.validate());
            }
            case SHEET_ADD -> {
                // do Nothing(switch States does all the work)
            }
            case SETTINGS -> {
                // do Nothing(switch States does all the work)
            }
        }
    }

    /**
     * switch the state of menuState
     *
     * @param newState the new state
     * @see SheetMenuState
     */
    private void switchMenuStates(SheetMenuState newState) {
        menuState = newState;
        menuPanels.stream()
                .forEach(
                        e -> {
                            e.setVisible(false);
                        });
        // only creates emitPanel when there is an active cut and sheet
        if (selectedSheet != null && selectedSheet.getActiveCut() != null) {
            if (emitPanel == null || !menuPanels.contains(emitPanel)) {
                emitPanel = new EmitSelect();
                add(emitPanel);
                emitPanel.setBounds(editMenu.getBounds());
                menuPanels.add(emitPanel);
            }
            emitPanel.setVisible(false);
        } else if (emitPanel != null && menuPanels.contains(emitPanel)) {
            remove(emitPanel);
            menuPanels.remove(emitPanel);
            emitPanel = null;
        }
        repaint();
    }

    @Override
    public void mouseClicked(MouseEvent e) {
    }

    @Override
    public void mousePressed(MouseEvent e) {
        if (e.getButton() == MouseEvent.BUTTON1 && state == State.SHEET_EDIT) {
            if (menuState == MEASURE) {
                if (measurePoint1 == null) {
                    measurePoint1 = (Point2D.Double) screenToSheet(new Point2D.Double(e.getX(), e.getY()));
                } else if (measurePoint2 == null) {
                    measurePoint2 = (Point2D.Double) screenToSheet(new Point2D.Double(e.getX(), e.getY()));
                } else {
                    measurePoint1 = null;
                    measurePoint2 = null;
                }
            } else if (menuState == ADD_HOLE && aHeld) {
                Point2D.Double holePoint = actualScreenToSheet(e.getPoint());

                Hole hole = selectedSheet.addHole(holePoint.getX(), holePoint.getY());

                undoList.add(new EditAction(hole, true));
            } else if (menuState == ADD_ITEM && aHeld) {
                if (selectedSheet == null || selectedSheet.getActiveCut() == null) {
                    JOptionPane.showMessageDialog(this,
                            "No active cut. Please add a cut first before adding parts.",
                            "No Active Cut", JOptionPane.WARNING_MESSAGE);
                } else if (itemSelectMenu == null || itemSelectMenu.partFileToPlace == null
                        || !itemSelectMenu.partFileToPlace.exists()) {
                    JOptionPane.showMessageDialog(this,
                            "Select a valid part folder from the parts library first.",
                            "No Part Selected", JOptionPane.WARNING_MESSAGE);
                } else {
                    Point2D.Double partPoint = actualScreenToSheet(e.getPoint());

                    Part part = selectedSheet.addPart(
                            itemSelectMenu.partFileToPlace, partPoint.getX(), partPoint.getY());

                    if (part != null) {
                        undoList.add(new EditAction(part, true));
                    }
                }
            } else {
                if (selectSheet != null) {
                    Point2D grabLocation = screenToSheet(e.getPoint());
                    partBeingDragged = selectedSheet.contains(grabLocation);

                    if (ctrlPressed && rotationPoint == null) {
                        rotatingPart = true;
                        rotationPoint = grabLocation;
                    } else if (partBeingDragged != null) {
                        if (selectedPart != null && !selectedPart.equivalent(partBeingDragged)) {
                            selectedPart.setSelected(false);
                        }
                        partBeingDragged.setSelected(true);
                        selectedPart = partBeingDragged;
                        if (ctrlPressed) {
                            draggingPart = true;
                            partGrabbedX = grabLocation.getX();
                            partGrabbedY = grabLocation.getY();
                            partGrabbedInitialRot = partBeingDragged.getRot();
                            partGrabbedInitialX = partBeingDragged.getX();
                            partGrabbedInitialY = partBeingDragged.getY();

                        } else {
                            draggingPart = true;
                            partGrabbedX = grabLocation.getX();
                            partGrabbedY = grabLocation.getY();
                            partGrabbedInitialRot = partBeingDragged.getRot();
                            partGrabbedInitialX = partBeingDragged.getX();
                            partGrabbedInitialY = partBeingDragged.getY();
                        }
                    } else {
                        startX = xCorner - e.getX() / zoom;
                        startY = yCorner - e.getY() / zoom;
                        if (selectedPart != null) {
                            selectedPart.setSelected(false);
                            selectedPart = null;
                        }
                        panning = true;
                    }
                }
            }
        }
        repaint();
    }

    @Override
    public void mouseReleased(MouseEvent e) {
        if (e.getButton() == MouseEvent.BUTTON1) {
            if (draggingPart) {
                EditAction toBeUndone = new EditAction(
                        partBeingDragged, partGrabbedInitialX,
                        partGrabbedInitialY, partGrabbedInitialRot);
                undoList.add(toBeUndone);
                redoList.clear();
                partBeingDragged = null;
            }
            panning = false;
            draggingPart = false;
        }
    }

    @Override
    public void mouseEntered(MouseEvent e) {
    }

    @Override
    public void mouseExited(MouseEvent e) {
    }

    @Override
    public void mouseDragged(MouseEvent e) {
        if (panning) {
            xCorner = startX + e.getX() / zoom;
            yCorner = startY + e.getY() / zoom;
        } else if (draggingPart) {
            Point2D movedPoint = screenToSheet(e.getPoint());
            if (rotatingPart
                    && rotationPoint != null
                    && partGrabbedX - rotationPoint.getX() != 0
                    && movedPoint.getX() - rotationPoint.getX() != 0) {
                // oo fun rotation i had no pain at all coding this

                // get the starting angle from the rotation point
                double startingAngle = Math.atan(
                        (partGrabbedY - rotationPoint.getY()) / (partGrabbedX - rotationPoint.getX()));
                if ((partGrabbedX - rotationPoint.getX()) > 0) {
                    startingAngle += Math.PI;
                }

                // get the ending angle from the rotation point
                double endingAngle = Math.atan(
                        (movedPoint.getY() - rotationPoint.getY())
                                / (movedPoint.getX() - rotationPoint.getX()));
                if ((movedPoint.getX() - rotationPoint.getX()) > 0) {
                    endingAngle += Math.PI;
                }
                double rot = endingAngle - startingAngle;

                // now time for the movement!!!! yay!!!!!!!!!!!!!!
                // so baiscally what i need to do is translate the ctrl point along the
                // same rotation as if it were attachted to the part and then move the
                // part by the offset
                Point2D.Double ctrlPoint = (Point2D.Double) rotationPoint.clone();

                // translate it so the part center is at 0,0
                ctrlPoint.setLocation(
                        ctrlPoint.getX() - partGrabbedInitialX + selectedSheet.getWidth(),
                        ctrlPoint.getY() + partGrabbedInitialY - selectedSheet.getHeight());

                // rotate it the same angle
                ctrlPoint.setLocation(
                        ctrlPoint.getX() * Math.cos(rot) + ctrlPoint.getY() * -Math.sin(rot),
                        ctrlPoint.getX() * Math.sin(rot) + ctrlPoint.getY() * Math.cos(rot));

                // translate it back
                ctrlPoint.setLocation(
                        ctrlPoint.getX() + partGrabbedInitialX - selectedSheet.getWidth(),
                        ctrlPoint.getY() - partGrabbedInitialY + selectedSheet.getHeight());

                // get the difference
                double xDiff = ctrlPoint.getX() - rotationPoint.getX();
                double yDiff = ctrlPoint.getY() - rotationPoint.getY();

                // translate part
                partBeingDragged.setX(partGrabbedInitialX - xDiff);
                partBeingDragged.setY(partGrabbedInitialY + yDiff);
                partBeingDragged.setRot(partGrabbedInitialRot - rot);
            } else {
                partBeingDragged.setX(partBeingDragged.getX() - partGrabbedX + movedPoint.getX());
                partBeingDragged.setY(partBeingDragged.getY() + partGrabbedY - movedPoint.getY());
                partGrabbedX = movedPoint.getX();
                partGrabbedY = movedPoint.getY();
            }
        }
        repaint();
    }

    @Override
    public void mouseMoved(MouseEvent e) {
    }

    @Override
    public void actionPerformed(ActionEvent e) {
        if (e.getSource() == addSheet) {
            switchStates(State.SHEET_ADD);
        } else if (e.getSource() == selectSheet) {
            File sheetFile = sheetList.getSelectedValue();
            if (sheetFile != null) {
                for (File file : sheetFile.listFiles()) {
                    if (file.getName().endsWith(".sheet")) {
                        sheetFile = file;
                        break;
                    }
                }
            }

            // Sheet() now only does fast binary I/O — Part construction and all
            // NGC parsing are fully deferred to Sheet.executor background threads.
            // We switch to SHEET_EDIT as soon as the constructor returns, with no
            // wait cursor needed. Parts paint themselves as their futures resolve,
            // each triggering its own repaint() via SwingUtilities.invokeLater.
            selectSheet.setEnabled(false);
            addSheet.setEnabled(false);

            final File sheetToLoad = sheetFile;
            new Thread(() -> {
                final Sheet loaded;
                try {
                    loaded = new Sheet(sheetToLoad);
                } catch (Exception ex) {
                    SwingUtilities.invokeLater(() -> {
                        new ErrorDialog(ex);
                        selectSheet.setEnabled(true);
                        addSheet.setEnabled(true);
                    });
                    return;
                }

                // Switch to edit view immediately — parts appear as they finish parsing
                SwingUtilities.invokeLater(() -> {
                    selectedSheet = loaded;
                    switchStates(State.SHEET_EDIT);
                    selectSheet.setEnabled(true);
                    addSheet.setEnabled(true);
                    repaint();
                });
            }, "sheet-loader").start();
        } else if (e.getSource() == returnToHome) {
            int leaveConfirm = JOptionPane.showConfirmDialog(
                    this,
                    "Are you sure you want to leave this sheet? Unsaved changes will be lost.",
                    "Leave Sheet",
                    JOptionPane.YES_NO_OPTION);
            if (leaveConfirm == JOptionPane.YES_OPTION) {
                switchStates(State.SHEET_SELECT);
            }
        } else if (e.getSource() == addHole) {
            if (selectedSheet.getActiveCut() == null) {
                JOptionPane.showMessageDialog(this,
                        "No active cut. Please add a cut first before adding holes.",
                        "No Active Cut", JOptionPane.WARNING_MESSAGE);
            } else if (menuState == HOME) {
                switchMenuStates(ADD_HOLE);
            } else if (menuState == ADD_HOLE) {
                switchMenuStates(HOME);
            }
            addHole.setSelected(menuState == ADD_HOLE);
        } else if (e.getSource() == addItem) {
            if (selectedSheet.getActiveCut() == null) {
                JOptionPane.showMessageDialog(this,
                        "No active cut. Please add a cut first before adding parts.",
                        "No Active Cut", JOptionPane.WARNING_MESSAGE);
            } else {
                switchMenuStates(ADD_ITEM);
            }
        } else if (e.getSource() == del) {
            deleteSelected.actionPerformed(e);
        } else if (e.getSource() == reScan) {
            // reload parts off the EDT
            reScan.setEnabled(false);
            setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.WAIT_CURSOR));
            if (editMenu != null && editMenu.buffer != null) editMenu.buffer.setText("Reloading parts...");
            new Thread(() -> {
                for (Cut cut : selectedSheet.getCuts()) {
                    for (Part part : new ArrayList<>(cut.parts)) { // iterate a snapshot
                        part.reload();
                    }
                }
                SwingUtilities.invokeLater(() -> {
                    zoom = 20;
                    xCorner = getWidth() / 2.0 + selectedSheet.getWidth() * 10.0;
                    yCorner = getHeight() / 2.0 - selectedSheet.getHeight() * 10.0;
                    xCorner /= zoom;
                    yCorner /= zoom;
                    reScan.setEnabled(true);
                    setCursor(java.awt.Cursor.getDefaultCursor());
                    if (editMenu != null && editMenu.buffer != null) editMenu.buffer.setText("");
                    repaint();
                });
            }, "rescan-loader").start();
        } else if (e.getSource() == theButton) {
            removeAll();
            specialDetect = true;
        } else if (e.getSource() == emit) {
            if (emitPanel != null) {
                remove(emitPanel);
                menuPanels.remove(emitPanel);
            }
            emitPanel = new EmitSelect();
            emitPanel.setBounds(editMenu.getBounds());
            emitPanel.setVisible(false);
            add(emitPanel);
            menuPanels.add(emitPanel);
            switchMenuStates(EMIT_SELECT);
        } else if (e.getSource() == save) {
            int saveConfirm = JOptionPane.showConfirmDialog(
                    this,
                    "Are you sure you want to save?",
                    "Save Sheet",
                    JOptionPane.YES_NO_OPTION);
            if (saveConfirm == JOptionPane.YES_OPTION) {
                saveSheet.actionPerformed(e);
                undoList.clear();
                redoList.clear();
            }
        } else if (e.getSource() == addCut) {
            switchMenuStates(ADD_CUT);
        } else if (e.getSource() == newCutButton) {
            File temp = new File(selectedSheet.getParentFile(), newCutField.getText() + ".cut");
            selectedSheet.addCut(new Cut(temp, selectedSheet.getHolesFile()));
            switchMenuStates(HOME);
        } else if (e.getSource() == changeGCodeView) {
            if (menuState == GCODE_SELECT) {
                switchMenuStates(HOME);
            } else {
                remove(gcodeCutPanel);
                menuPanels.remove(gcodeCutPanel);
                gcodeCutPanel = new CutSelectGcode();
                gcodeCutPanel.setBounds(editMenu.getBounds());
                add(gcodeCutPanel);
                menuPanels.add(gcodeCutPanel);
                switchMenuStates(GCODE_SELECT);
            }
        } else if (e.getSource() == measure) {
            if (menuState == MEASURE) {
                switchMenuStates(HOME);
            } else {
                switchMenuStates(MEASURE);
            }
            measure.setSelected(menuState == MEASURE);
        } else if (e.getSource() == changeCut) {
            if (menuState == CUT_SELECT) {
                switchMenuStates(HOME);
            } else {
                remove(cutPanel);
                menuPanels.remove(cutPanel);
                cutPanel = new CutSelect();
                cutPanel.setBounds(editMenu.getBounds());
                add(cutPanel);
                menuPanels.add(cutPanel);
                switchMenuStates(CUT_SELECT);
            }
        } else if (e.getSource() instanceof ReturnToHomeJButton) {
            switchMenuStates(HOME);
        } else if (e.getSource() instanceof FileJRadioButton
                && ((FileJRadioButton) e.getSource()).getType().equals(CUT_SELECT)) {
            selectedSheet.changeActiveCutFile(((FileJRadioButton) e.getSource()).getFile());
        } else if (e.getSource() instanceof SheetHandlerJButtonCut) {
            gcodePartPanel = new PartSelectGcode(((SheetHandlerJButtonCut) e.getSource()).getgenericThing());
            add(gcodePartPanel);
            gcodePartPanel.setBounds(editMenu.getBounds());
            menuPanels.add(gcodePartPanel);
            switchMenuStates(GCODE_SELECT_PART);
        } else if (e.getSource() instanceof SheetHandlerJButtonPart) {
            Cut savedCut = ((PartSelectGcode) gcodePartPanel).getCut();
            remove(gcodePartPanel);
            menuPanels.remove(gcodePartPanel);
            gcodePartPanel = new GCodeSelectGcode(
                    ((SheetHandlerJButtonPart) e.getSource()).getgenericThing(),
                    savedCut);
            gcodePartPanel.setBounds(editMenu.getBounds());
            add(gcodePartPanel);
            menuPanels.add(gcodePartPanel);
        } else if (e.getSource() instanceof ReturnOnceJButton && menuState == GCODE_SELECT_PART) {
            ((Returnable) gcodePartPanel).returnTo();
        } else if (itemSelectMenu.fileButtons.contains(e.getSource())) {
            itemSelectMenu.selectFile(((ItemSelectMenu.FileJButton) e.getSource()).file());
        } else {
            for (JButton button : suffixes) {
                if (e.getSource() == button) {
                    HashSet<Integer> toolSet = new java.util.HashSet<>();

                    Point2D.Double origin = new Point2D.Double(0, 0);

                    File outputFolder = new File(
                            "./output/" + java.time.LocalDate.now().toString().replaceAll("-", ""));
                    outputFolder.mkdirs();
                    String fileName = emitPanel.gCodeName.getText().trim();
                    if (fileName.isEmpty()) {
                        fileName = selectedSheet.getActiveCut().getCutFile().getName();
                        if (fileName.contains(".")) {
                            fileName = fileName.substring(0, fileName.lastIndexOf('.'));
                        }
                    }
                    if (emitPanel.detectedExtension.equals("ERROR")) {
                        JOptionPane.showMessageDialog(
                                Screen.this,
                                "Cannot emit: mixed NGC and TAP files detected, or no valid gcode files found.\nPlease ensure all parts use the same file type.",
                                "File Type Error",
                                JOptionPane.ERROR_MESSAGE);
                        break;
                    }

                    File outputFile = new File(outputFolder, fileName + emitPanel.detectedExtension);

                    for (Part part : selectedSheet.getActiveCut()) {
                        // This loads the correct NGCDocument for the part
                        if (part.setSelectedGCode(button.getText(), outputFile)) {
                            // Now getNgcDocument() returns the loaded doc
                            if (part.getNgcDocument() != null) {
                                toolSet.addAll(part.getNgcDocument().getToolTable().keySet());
                            }
                        }
                    }
                    toolSet.remove(0); // Remove header tool
                    ArrayList<Integer> toolList = new ArrayList<>(toolSet);
                    Collections.sort(toolList);

                    // 3. If confirmed, Emit
                    List<Integer> finalOrder = toolList;

                    // 2. Show the Popup Dialog
                    if (toolList.size() > 1) {
                        ToolOrderDialog dialog = new ToolOrderDialog(
                                (java.awt.Frame) SwingUtilities.getWindowAncestor(this), toolList);
                        dialog.setVisible(true); // Pauses here until dialog closes
                        finalOrder = dialog.getResult();
                    }
                    if (finalOrder != null) {

                        selectedSheet.emitGCode(
                                outputFile, button.getText(), origin, finalOrder);
                    }
                }
            }
        }
        repaint();
    }

    @Override
    public void paint(Graphics g) {
        if (specialDetect == true) {
            super.paintComponent(g);
            Graphics2D g2d = (Graphics2D) g;
            g2d.scale(0.5, 0.5);
            for (int i = 0; i < imgs.size(); i++) {
                g2d.drawImage(imgs.get(i), 0 + i % 2 * 800, 0 + i / 2 * 800, null);
            }
        } else {
            super.paint(g);
        }
    }

    @Override
    public void valueChanged(ListSelectionEvent e) {
        if (e.getSource() == sheetList) {
            if (sheetList.getSelectedIndex() == -1) {
                selectSheet.setEnabled(false);
            } else {
                selectSheet.setEnabled(true);
            }
        }
    }

    @Override
    public void mouseWheelMoved(MouseWheelEvent e) {
        if (state == State.SHEET_EDIT) {
            // get the actual xy coord selected
            double xPos = e.getX() / zoom;
            double yPos = e.getY() / zoom;

            // translate the corner to the orgin
            xCorner -= xPos;
            yCorner -= yPos;

            // something something sigmoid
            zoom *= 1 / Math.pow(Math.E, e.getPreciseWheelRotation() / 10);

            // translate the point back
            xCorner += e.getX() / zoom;
            yCorner += e.getY() / zoom;

            repaint();
        }
    }

    /**
     * Create a new sheet based on the given parameters
     *
     * @param sheetWidth - the width of the sheet (almost always will be negative)
     * @param sheetY     - the height of the sheet
     * @param sheetName  - the name of the sheet
     */
    public void enterNewSheetInfo(
            double sheetWidth, double sheetHeight, String sheetName, SheetThickness thickness) {
        selectedSheet = new Sheet(sheetsParent, sheetName, sheetWidth, sheetHeight, thickness);
        refreshSheetFileList();

        for (int i = 0; i < sheetList.getModel().getSize(); i++) {
            File candidate = sheetList.getModel().getElementAt(i);
            if (candidate.getName().equals(sheetName)) {
                sheetList.setSelectedIndex(i);
                sheetList.ensureIndexIsVisible(i);
                break;
            }
        }

        switchStates(State.SHEET_SELECT);
    }

    public void returnToNormal() {
        switchStates(State.SHEET_SELECT);
    }

    private void refreshSheetFileListAsync() {
        new Thread(() -> {
            DefaultListModel<File> refreshed = new DefaultListModel<>();
            File[] latestFiles = sheetsParent.listFiles();
            if (latestFiles != null) {
                for (File sf : latestFiles) {
                    if (sf.getName().startsWith(".")) continue;
                    refreshed.addElement(
                            new File(sf.getAbsolutePath()) {
                                @Override
                                public String toString() {
                                    return getName();
                                }
                            });
                }
            }

            SwingUtilities.invokeLater(() -> {
                sheetFileList = refreshed;
                applySheetSearchFilter();
            });
        }, "sheet-list-loader").start();
    }

    private void refreshSheetFileList() {
        DefaultListModel<File> refreshed = new DefaultListModel<>();
        File[] latestFiles = sheetsParent.listFiles();
        if (latestFiles != null) {
            for (File sf : latestFiles) {
                if (sf.getName().startsWith(".")) continue;
                refreshed.addElement(
                        new File(sf.getAbsolutePath()) {
                            @Override
                            public String toString() {
                                return getName();
                            }
                        });
            }
        }
        sheetFileList = refreshed;
        applySheetSearchFilter();
    }

    private void applySheetSearchFilter() {
        if (sheetSearch == null || sheetList == null) {
            return;
        }
        String query = sheetSearch.getText().toLowerCase();
        DefaultListModel<File> filtered = new DefaultListModel<>();
        for (int i = 0; i < sheetFileList.size(); i++) {
            File f = sheetFileList.get(i);
            if (f.getName().toLowerCase().contains(query)) {
                filtered.addElement(f);
            }
        }
        sheetList.setModel(filtered);
    }

    /**
     * Switch between program states
     *
     * @param newState - the state to switch to
     */
    private void switchStates(State newState) {
        // clears all JPanels
        menuPanels.stream()
                .forEach(
                        e -> {
                            e.setVisible(false);
                        });

        // sets all components needed visible/not visible
        switch (newState) {
            case SETTINGS -> {
                state = State.SETTINGS;
                switchMenuStates(NULL);
                returnToHome.setVisible(false);
                selectSheet.setVisible(false);
                addSheet.setVisible(false);
                sheetList.setVisible(false);
                sheetScroll.setVisible(false);
                sheetSearch.setVisible(false);
                newSheetPrompt.setVisible(false);
                settingsPanel.setup();
                settingsPanel.setVisible(true);
                returnToHomeFromSettings.setVisible(true);
                toSettings.setVisible(false);
                resetToDefault.setVisible(true);
                restartApplication.setVisible(true);
            }
            case SHEET_SELECT -> {
                state = State.SHEET_SELECT;
                switchMenuStates(NULL);
                selectSheet.setVisible(true);
                addSheet.setVisible(true);

                refreshSheetFileListAsync();
                sheetList.setVisible(true);
                sheetScroll.setVisible(true);
                sheetSearch.setVisible(true);
                newSheetPrompt.setVisible(false);
                returnToHome.setVisible(false);
                settingsPanel.setVisible(false);
                returnToHomeFromSettings.setVisible(false);
                toSettings.setVisible(true);
                resetToDefault.setVisible(false);
                restartApplication.setVisible(false);
            }
            case SHEET_EDIT -> {
                state = State.SHEET_EDIT;
                switchMenuStates(HOME);
                settingsPanel.setVisible(false);
                returnToHome.setVisible(true);
                selectSheet.setVisible(false);
                addSheet.setVisible(false);
                sheetList.setVisible(false);
                sheetScroll.setVisible(false);
                sheetSearch.setVisible(false);
                returnToHomeFromSettings.setVisible(false);
                toSettings.setVisible(false);
                resetToDefault.setVisible(false);
                restartApplication.setVisible(false);
                zoom = 20;
                xCorner = getWidth() / 2.0 + selectedSheet.getWidth() * 10.0;
                yCorner = getHeight() / 2.0 - selectedSheet.getHeight() * 10.0;
                xCorner /= zoom;
                yCorner /= zoom;
                newSheetPrompt.setVisible(false);

                gcodeCutPanel = new CutSelectGcode();
                add(gcodeCutPanel);
                gcodeCutPanel.setBounds(editMenu.getBounds());
                menuPanels.add(gcodeCutPanel);

                if (selectedSheet.getActiveCut() != null) {
                    emitPanel = new EmitSelect();
                    add(emitPanel);
                    emitPanel.setBounds(editMenu.getBounds());
                    menuPanels.add(emitPanel);
                }

                cutPanel = new CutSelect();
                add(cutPanel);
                cutPanel.setBounds(editMenu.getBounds());
                menuPanels.add(cutPanel);

                menuPanels.stream().forEach(e -> e.setVisible(false));
            }
            case SHEET_ADD -> {
                state = State.SHEET_ADD;
                switchMenuStates(NULL);
                settingsPanel.setVisible(false);
                returnToHomeFromSettings.setVisible(false);
                returnToHome.setVisible(false);
                toSettings.setVisible(false);
                resetToDefault.setVisible(false);
                selectSheet.setVisible(false);
                addSheet.setVisible(false);
                sheetList.setVisible(false);
                sheetScroll.setVisible(false);
                sheetSearch.setVisible(false);
                newSheetPrompt.reset();
                newSheetPrompt.setVisible(true);
                restartApplication.setVisible(false);
            }
        }
    }

    private Point2D screenToSheet(Point2D in) {
        Point2D out = new Point2D.Double(in.getX(), in.getY());
        out.setLocation(out.getX() - xCorner * zoom, out.getY() - yCorner * zoom);
        out.setLocation(out.getX() / zoom, out.getY() / zoom);
        return out;
    }

    private Point2D.Double actualScreenToSheet(Point2D in) {
        Point2D.Double out = new Point2D.Double(in.getX(), in.getY());
        out.setLocation(out.getX() - xCorner * zoom, out.getY() - yCorner * zoom);
        out.setLocation(out.getX() / zoom, out.getY() / zoom);

        out.setLocation(out.getX() + selectedSheet.getWidth(), selectedSheet.getHeight() - out.getY());
        return out;
    }

    private Point2D sheetToScreen(Point2D in) {
        Point2D out = new Point2D.Double(in.getX(), in.getY());
        out.setLocation(out.getX() * zoom, out.getY() * zoom);
        out.setLocation(out.getX() + xCorner * zoom, out.getY() + yCorner * zoom);
        return out;
    }

    private String getActiveCutFormatIndicator() {
        if (selectedSheet == null || selectedSheet.getActiveCut() == null) return "ngc";
        boolean hasNgc = false;
        boolean hasTap = false;
        for (Part part : selectedSheet.getActiveCut()) {
            NGCDocument doc = part.getNgcDocument();
            if (doc != null) {
                if (doc.getNgcStrain() == NgcStrain.router_WinCNC) hasTap = true;
                if (doc.getNgcStrain() == NgcStrain.router_971) hasNgc = true;
            }
        }
        if (hasNgc && hasTap) return "error";
        if (hasTap) return "tap";
        return "ngc";
    }

    public void updateCutNameLabel() {
        if (cutName == null) return;
        if (selectedSheet == null || selectedSheet.getActiveCutFile() == null) {
            cutName.setText("Current Cut: ");
            cutName.setForeground(Color.WHITE);
        } else {
            cutName.setText("Current Cut: " + selectedSheet.getActiveCutFile().getName());
            cutName.setForeground(Color.WHITE);
        }

    }

    @Override
    public void itemStateChanged(ItemEvent e) {
        Object source = e.getItemSelectable();
        if (source instanceof SheetHandlerJCheckBoxNGCDoc) {
            SheetHandlerJCheckBoxNGCDoc thing = (SheetHandlerJCheckBoxNGCDoc) source;
            if (e.getStateChange() == ItemEvent.SELECTED) {
                thing.getPart().addActiveGcode(thing.getgenericThing());
            }
            if (e.getStateChange() == ItemEvent.DESELECTED) {
                thing.getPart().removeActiveGcode(thing.getgenericThing());
            }
        }
        repaint();
    }

    /** JPanel that makes the default/home menu state */
    private class SheetEditMenu extends JPanel {
        // JLabel that fills up all the gap at the bottom
        private JLabel buffer;
        // (progress bar removed)

        public SheetEditMenu() {
            setLayout(new GridBagLayout());
            // sets menu to left edge of the screen
            setBounds(0, 0, 300, 800);

            // Adds menu buttons and text in a grid system
            GridBagConstraints c = new GridBagConstraints();
            c.fill = GridBagConstraints.HORIZONTAL;
            c.anchor = GridBagConstraints.FIRST_LINE_START;
            c.insets = new Insets(5, 5, 5, 5);
            c.ipady = 20;
            c.weightx = 0.33;

            // Row 0: Return to Home (full width)
            c.gridx = 0;
            c.gridy = 0;
            c.gridwidth = 3;
            c.ipady = 20;
            add(returnToHome, c);

            // Row 1: Sheet name label
            sheetName = new JLabel("Editing Sheet: ");
            sheetName.setForeground(Color.WHITE);
            c.gridx = 0;
            c.gridy = 1;
            c.gridwidth = 3;
            add(sheetName, c);

            // Row 2: Add Hole | Add Item | Del Select
            addHole = new JButton("Add Hole");
            c.gridx = 0;
            c.gridy = 2;
            c.gridwidth = 1;
            add(addHole, c);
            addHole.addActionListener(Screen.this);

            addItem = new JButton("Add Item");
            c.gridx = 1;
            c.gridy = 2;
            add(addItem, c);
            addItem.addActionListener(Screen.this);

            del = new JButton("Del Select");
            c.gridx = 2;
            c.gridy = 2;
            add(del, c);
            del.addActionListener(Screen.this);

            // Row 3: Reload | Change GCode | Measure
            reScan = new JButton("Reload");
            c.gridx = 0;
            c.gridy = 3;
            c.gridwidth = 1;
            add(reScan, c);
            reScan.addActionListener(Screen.this);

            changeGCodeView = new JButton("Change GCode");
            c.gridx = 1;
            c.gridy = 3;
            add(changeGCodeView, c);
            changeGCodeView.addActionListener(Screen.this);

            measure = new JButton("Measure");
            c.gridx = 2;
            c.gridy = 3;
            add(measure, c);
            measure.addActionListener(Screen.this);

            // Row 4: Save | Undo | Redo
            save = new JButton("Save");
            c.gridx = 0;
            c.gridy = 4;
            c.gridwidth = 1;
            add(save, c);
            save.addActionListener(Screen.this);

            undoButton = new JButton("Undo");
            c.gridx = 1;
            c.gridy = 4;
            add(undoButton, c);
            undoButton.addActionListener(e2 -> undo.actionPerformed(e2));

            redoButton = new JButton("Redo");
            c.gridx = 2;
            c.gridy = 4;
            add(redoButton, c);
            redoButton.addActionListener(e2 -> redo.actionPerformed(e2));

            // Row 5: Emit GCode | Add Cut | Select Cut
            emit = new JButton("Emit GCode");
            c.gridx = 0;
            c.gridy = 5;
            c.gridwidth = 1;
            add(emit, c);
            emit.addActionListener(Screen.this);

            addCut = new JButton("Add Cut");
            c.gridx = 1;
            c.gridy = 5;
            add(addCut, c);
            addCut.addActionListener(Screen.this);

            changeCut = new JButton("Select Cut");
            c.gridx = 2;
            c.gridy = 5;
            add(changeCut, c);
            changeCut.addActionListener(Screen.this);

            // Row 6: Cut name label
            cutName = new JLabel("Current Cut: ");
            cutName.setForeground(Color.WHITE);
            c.gridx = 0;
            c.gridy = 6;
            c.gridwidth = 3;
            add(cutName, c);

            // bottom buffer
            buffer = new JLabel();
            buffer.setForeground(Color.WHITE);
            c.gridwidth = 3;
            c.gridx = 0;
            c.gridy = 7;
            c.weighty = 1;
            add(buffer, c);

            // progress indicator removed

            if (selectedSheet != null) {
                sheetName.setText("Editing Sheet: " + selectedSheet.getSheetFile().getName());
                updateCutNameLabel();
            }
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            if (selectedSheet != null) {
                sheetName.setText("Editing Sheet: " + selectedSheet.getSheetFile().getName());
                updateCutNameLabel();
            }
            returnToHome.setText(
                    (menuState == HOME || menuState == MEASURE) ? "Exit Sheet" : "Return to Home");
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }

        public void showAMessage() {
            buffer.setText("Hold a to add holes");
        }

        public void hideAMessage() {
            buffer.setText("");
        }
    }

    /** First menu when changing GCode viewed Selects which cut to change to */
    private class CutSelectGcode extends JPanel {
        private CutSelectGcode() {
            setLayout(new java.awt.BorderLayout());
            ReturnToHomeJButton rth = returnToHomeMenu.clone();
            rth.setPreferredSize(new Dimension(0, 50));
            add(rth, java.awt.BorderLayout.NORTH);

            JPanel inner = new JPanel();
            inner.setLayout(new javax.swing.BoxLayout(inner, javax.swing.BoxLayout.Y_AXIS));
            inner.setBackground(Color.BLACK);
            inner.add(new JLabel("Select Cut to Change: ") {{ setForeground(Color.WHITE); }});

            for (Cut cut : selectedSheet.getCuts()) {
                SheetHandlerJButtonCut btn = new SheetHandlerJButtonCut(cut.getCutFile().getName(), cut) {{
                    addActionListener(Screen.this);
                    setPreferredSize(new Dimension(0, 50));
                    setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
                }};
                inner.add(btn);
            }

            JScrollPane sp = new JScrollPane(inner);
            sp.setBorder(null);
            sp.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            sp.getVerticalScrollBar().setUnitIncrement(50);
            add(sp, java.awt.BorderLayout.CENTER);
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }
    }

    /** Second menu when changing GCode viewed Selects which part to change to */
    private class PartSelectGcode extends JPanel implements Returnable {
        private Cut cut;

        private PartSelectGcode(Cut cut) {
            this.cut = cut;
            setLayout(new java.awt.BorderLayout());

            JPanel topBar = new JPanel(new GridLayout(2, 1, 0, 2));
            topBar.setBackground(Color.BLACK);
            ReturnToHomeJButton rth = returnToHomeMenu.clone();
            rth.setPreferredSize(new Dimension(0, 50));
            topBar.add(rth);
            JButton retOnce = returnOnce.clone();
            retOnce.setPreferredSize(new Dimension(0, 50));
            topBar.add(retOnce);
            add(topBar, java.awt.BorderLayout.NORTH);

            JPanel inner = new JPanel();
            inner.setLayout(new javax.swing.BoxLayout(inner, javax.swing.BoxLayout.Y_AXIS));
            inner.setBackground(Color.BLACK);
            inner.add(new JLabel("Select Part to Change: ") {{ setForeground(Color.WHITE); }});

            for (Part part : cut) {
                if (part instanceof Hole) continue;
                SheetHandlerJButtonPart btn = new SheetHandlerJButtonPart(part.partFile().getName(), part) {{
                    addActionListener(Screen.this);
                    setPreferredSize(new Dimension(0, 50));
                    setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
                }};
                inner.add(btn);
            }

            JScrollPane sp = new JScrollPane(inner);
            sp.setBorder(null);
            sp.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            sp.getVerticalScrollBar().setUnitIncrement(50);
            add(sp, java.awt.BorderLayout.CENTER);
        }

        private Cut getCut() {
            return cut;
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }

        // allows state to change back to selecting cuts
        @Override
        public void returnTo() {
            switchMenuStates(GCODE_SELECT);
        }
    }

    /**
     * Third and last menu when changing GCode viewed Selects which gcode to view
     */
    private class GCodeSelectGcode extends JPanel implements Returnable {
        private Cut cut;

        private GCodeSelectGcode(Part part, Cut cut) {
            this.cut = cut;
            setLayout(new java.awt.BorderLayout());

            JPanel topBar = new JPanel(new GridLayout(2, 1, 0, 2));
            topBar.setBackground(Color.BLACK);
            ReturnToHomeJButton rth = returnToHomeMenu.clone();
            rth.setPreferredSize(new Dimension(0, 50));
            topBar.add(rth);
            JButton retOnce = returnOnce.clone();
            retOnce.setPreferredSize(new Dimension(0, 50));
            topBar.add(retOnce);
            add(topBar, java.awt.BorderLayout.NORTH);

            JPanel inner = new JPanel();
            inner.setLayout(new javax.swing.BoxLayout(inner, javax.swing.BoxLayout.Y_AXIS));
            inner.setBackground(Color.BLACK);
            inner.add(new JLabel("Select GCode File to View: ") {{ setForeground(Color.WHITE); }});

            for (NGCDocument docs : part.getAllNgcDocuments()) {
                inner.add(new SheetHandlerJCheckBoxNGCDoc(docs.getGcodeFile().getName(), docs, part) {{
                    addItemListener(Screen.this);
                    if (part.getNgcDocuments().stream().anyMatch(e -> e.equals(docs))) {
                        setSelected(true);
                    }
                    setForeground(Color.WHITE);
                    setOpaque(false);
                    setPreferredSize(new Dimension(0, 50));
                    setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
                }});
            }

            JScrollPane sp = new JScrollPane(inner);
            sp.setBorder(null);
            sp.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            sp.getVerticalScrollBar().setUnitIncrement(50);
            add(sp, java.awt.BorderLayout.CENTER);
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }

        // used to return to previous menus
        public Cut getCut() {
            return cut;
        }

        // allows the panel to change back to Part select
        @Override
        public void returnTo() {
            returnToTemp();
        }
    }

    private void returnToTemp() {
        remove(gcodePartPanel);
        menuPanels.remove(gcodePartPanel);
        gcodePartPanel = new PartSelectGcode(((GCodeSelectGcode) gcodePartPanel).getCut());
        gcodePartPanel.setBounds(editMenu.getBounds());
        add(gcodePartPanel);
        menuPanels.add(gcodePartPanel);
    }

    /** Allows user to select which cut is active */
    private class CutSelect extends JPanel {
        private ButtonGroup buttons;

        private CutSelect() {
            setLayout(new java.awt.BorderLayout());
            ReturnToHomeJButton rth = returnToHomeMenu.clone();
            rth.setPreferredSize(new Dimension(0, 50));
            add(rth, java.awt.BorderLayout.NORTH);

            JPanel inner = new JPanel();
            inner.setLayout(new javax.swing.BoxLayout(inner, javax.swing.BoxLayout.Y_AXIS));
            inner.setBackground(Color.BLACK);
            inner.add(new JLabel("Select cut to activate:") {{ setForeground(Color.WHITE); }});

            buttons = new ButtonGroup();
            for (Cut cut : selectedSheet.getCuts()) {
                File cutFile = cut.getCutFile();
                FileJRadioButton rb = new FileJRadioButton(
                        cutFile.getName().substring(0, cutFile.getName().lastIndexOf(".cut")), CUT_SELECT) {{
                    addActionListener(Screen.this);
                    if (selectedSheet.getActiveCutFile() != null
                            && cutFile.getName().equals(selectedSheet.getActiveCutFile().getName())) {
                        setSelected(true);
                    }
                    setFile(cutFile);
                    setForeground(Color.WHITE);
                    setOpaque(false);
                    setPreferredSize(new Dimension(0, 50));
                    setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
                }};
                buttons.add(rb);
            }
            Collections.list(buttons.getElements()).stream().forEach(e -> inner.add(e));

            JScrollPane sp = new JScrollPane(inner);
            sp.setBorder(null);
            sp.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            sp.getVerticalScrollBar().setUnitIncrement(50);
            add(sp, java.awt.BorderLayout.CENTER);
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(300, 800);
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }
    }

    /**
     * Allows instanceof to be detected for returning to home in actionPerformed()
     * and implements
     * cloneable to allow the same text and location for subsequent buttons
     *
     * @see JButton
     */
    private class ReturnToHomeJButton extends JButton implements Cloneable {
        public ReturnToHomeJButton(String text) {
            super(text);
        }

        @Override
        public ReturnToHomeJButton clone() {
            return new ReturnToHomeJButton(this.getText()) {
                {
                    setBounds(this.getBounds());
                    addActionListener(Screen.this);
                }
            };
        }
    }

    /**
     * Allows instanceof to be detected for returning once(with the returnable
     * interface) in
     * actionPerformed() and implements cloneable to allow the same text and
     * location for subsequent
     * buttons
     *
     * @see JButton
     * @see ReturnToHomeJButton
     */
    private class ReturnOnceJButton extends JButton implements Cloneable {
        public ReturnOnceJButton(String text) {
            super(text);
        }

        @Override
        public ReturnOnceJButton clone() {
            return new ReturnOnceJButton(this.getText()) {
                {
                    setBounds(this.getBounds());
                    addActionListener(Screen.this);
                }
            };
        }
    }

    /**
     * The emit menu that allows which extension(aka endmill size) to emit and the
     * new file name
     */
    /**
 * The emit menu that allows which extension(aka endmill size) to emit and the
 * new file name
 */
    private class EmitSelect extends JPanel {

    public JTextField gCodeName;
    public JLabel gCodeNameLabel;
    public JLabel formatIndicator;

    private String detectedExtension;

    public EmitSelect() {

        setLayout(null);

        HashSet<String> suffixStrings = new HashSet<>();

        for (Part part : selectedSheet.getActiveCut()) {
            for (String suffix : part.getSuffixes()) {
                suffixStrings.add(suffix);
            }
        }

        suffixes = new JButton[suffixStrings.size()];

        for (int i = 0; i < suffixes.length; i++) {

            suffixes[i] =
                    new JButton((String) suffixStrings.toArray()[i]);

            suffixes[i].setBounds(
                    50,
                    120 + 50 * i,
                    200,
                    25);

            add(suffixes[i]);

            suffixes[i].addActionListener(Screen.this);

            if (i == suffixes.length - 1) {

                JButton returnToMain =
                        new ReturnToHomeJButton("Return to Home");

                returnToMain.setBounds(
                        50,
                        120 + 50 * (i + 1),
                        200,
                        50);

                add(returnToMain);

                returnToMain.addActionListener(Screen.this);
            }
        }

        gCodeName = new JTextField(
                selectedSheet
                        .getActiveCut()
                        .getCutFile()
                        .getName()
                        .substring(
                                0,
                                selectedSheet
                                        .getActiveCut()
                                        .getCutFile()
                                        .getName()
                                        .lastIndexOf('.')));

        gCodeName.setBounds(50, 50, 200, 25);

        add(gCodeName);

        gCodeNameLabel =
                new JLabel("gCode emission name:");

        gCodeNameLabel.setBounds(50, 25, 200, 25);

        gCodeNameLabel.setForeground(Color.WHITE);

        add(gCodeNameLabel);

        // file type label
        formatIndicator = new JLabel();

        formatIndicator.setBounds(50, 75, 200, 25);

        formatIndicator.setForeground(Color.WHITE);

        add(formatIndicator);

        updateFileTypeIndicator();
    }

    private void updateFileTypeIndicator() {

        boolean hasNgc = false;
        boolean hasTap = false;

        for (Part part : selectedSheet.getActiveCut()) {
            if (part instanceof Hole) continue;

            for (NGCDocument doc : part.getAllNgcDocuments()) {

                if (doc == null || doc.getGcodeFile() == null) {
                    continue;
                }

                String name =
                        doc.getGcodeFile()
                                .getName()
                                .toLowerCase();

                if (name.endsWith(".ngc")) {
                    hasNgc = true;
                }

                if (name.endsWith(".tap")) {
                    hasTap = true;
                }
            }
        }

        String fileType;

        if (hasNgc && hasTap) {

            fileType = "ERROR";

            detectedExtension = "ERROR";

        } else if (hasTap) {

            fileType = "TAP";

            detectedExtension = ".tap";

        } else if (hasNgc) {

            fileType = "NGC";

            detectedExtension = ".ngc";

        } else {

            fileType = "ERROR";

            detectedExtension = "ERROR";
        }

        formatIndicator.setText("File Type: " + fileType);
        formatIndicator.setForeground(Color.WHITE);
    }

    @Override
    public void paintComponent(Graphics g) {

        super.paintComponent(g);

        g.setColor(Color.BLACK);

        g.fillRect(0, 0, getWidth(), getHeight());
    }

    @Override
    public Dimension getPreferredSize() {

        return new Dimension(300, 800);
    }
}
    class NewCutMenu extends JPanel {
        public NewCutMenu() {
            setLayout(null);

            add(
                    new JLabel("Adding new sheet cut. Enter filename:") {
                        {
                            setBounds(10, 0, editMenu.getWidth(), 50);
                            setForeground(Color.WHITE);
                        }
                    });

            newCutField = new JTextField();
            newCutField.setBounds(10, 60, 200, 50);
            add(newCutField);

            newCutButton = new JButton("Add Sheet Cut");
            newCutButton.setBounds(10, 120, 200, 50);
            newCutButton.addActionListener(Screen.this);
            add(newCutButton);

            JButton cancelCutButton = new JButton("Return to Home");
            cancelCutButton.setBounds(10, 180, 200, 50);
            cancelCutButton.addActionListener(e -> switchMenuStates(HOME));
            add(cancelCutButton);
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);

            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }
    }

    class ItemSelectMenu extends JPanel {
        public ArrayList<JComponent> fileButtons;
        public File partFileToPlace;
        private JPanel listContainer;
        // The "Return" button shown when inside a subfolder. Permanently in the
        // header so we never rebuild or re-add it — we just show/hide it.
        private JButton subReturnButton;
        // Tracks the parent folder subReturnButton should navigate to.
        private File subReturnTarget;

        public ItemSelectMenu() {
            setLayout(new java.awt.BorderLayout());

            // Permanent two-row header pinned in NORTH.
            // Row 0: Return to Home — always visible, always 50 px.
            // Row 1: Return         — shown only while inside a subfolder, 50 px.
            ReturnToHomeJButton rthClone = returnToHomeMenu.clone();
            rthClone.setPreferredSize(new Dimension(0, 50));
            rthClone.setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));

            subReturnButton = new JButton("Return");
            subReturnButton.setPreferredSize(new Dimension(0, 50));
            subReturnButton.setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
            subReturnButton.setVisible(false);
            subReturnButton.addActionListener(e -> {
                if (subReturnTarget != null) selectFile(subReturnTarget);
            });

            JPanel headerPanel = new JPanel();
            headerPanel.setLayout(new javax.swing.BoxLayout(headerPanel, javax.swing.BoxLayout.Y_AXIS));
            headerPanel.setBackground(Color.BLACK);
            headerPanel.add(rthClone);
            headerPanel.add(subReturnButton);
            add(headerPanel, java.awt.BorderLayout.NORTH);

            // BoxLayout respects each button's preferredSize (50 px) instead of
            // stretching them to fill the panel the way GridLayout does.
            listContainer = new JPanel();
            listContainer.setLayout(new javax.swing.BoxLayout(listContainer, javax.swing.BoxLayout.Y_AXIS));
            listContainer.setBackground(Color.BLACK);

            // Wrap the listContainer in a ScrollPane
            JScrollPane scrollPane = new JScrollPane(listContainer);
            scrollPane.setBorder(null);
            scrollPane.getVerticalScrollBar().setUnitIncrement(16);
            scrollPane.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);

            add(scrollPane, java.awt.BorderLayout.CENTER);

            fileButtons = new ArrayList<>();

            selectFile(new File("./parts_library"));
        }

        @Override
        public void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, getWidth(), getHeight());
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(300, 800);
        }

        /**
         * Goes to the subordinate list or sets the selected file if it's not a
         * directory
         */
        public void selectFile(File file) {
            // Clear previous file buttons from the scroll list
            fileButtons.stream()
                    .forEach(
                            e -> {
                                listContainer.remove(e);
                                if (e instanceof JButton) {
                                    ((JButton) e).removeActionListener(Screen.this);
                                }
                            });
            fileButtons.clear();

            // Show/hide the persistent Return button — no NORTH rebuilding needed.
            if (!file.getName().equals("parts_library")) {
                subReturnTarget = file.getParentFile();
                subReturnButton.setVisible(true);
            } else {
                subReturnTarget = null;
                subReturnButton.setVisible(false);
            }

            // Guard: folder missing or unreadable (e.g. parts_library doesn't exist)
            File[] subFiles = file.listFiles();
            if (subFiles == null) {
                JLabel err = new JLabel("Folder not found: " + file.getPath());
                err.setForeground(Color.RED);
                listContainer.add(err);
                fileButtons.add(err);
                partFileToPlace = null;
                listContainer.revalidate();
                listContainer.repaint();
                return;
            }

            // Pass 1: add a button for every sub-directory
            boolean hasNonDirFiles = false;
            for (File subFile : subFiles) {
                if (subFile.isDirectory()) {
                    FileJButton button = new FileJButton(subFile);
                    fileButtons.add(button);
                    listContainer.add(button);
                    button.addActionListener(Screen.this);
                } else {
                    hasNonDirFiles = true;
                }
            }

            // Pass 2: if any non-directory files exist, this folder IS a placeable part
            if (hasNonDirFiles) {
                partFileToPlace = file;
                JLabel holdA = new JLabel("Hold 'a' + click anywhere on sheet to place");
                holdA.setForeground(Color.LIGHT_GRAY);
                listContainer.add(holdA);
                fileButtons.add(holdA);
            } else {
                partFileToPlace = null;
            }

            listContainer.revalidate();
            listContainer.repaint();
            return;
        }

        /** creates a JButton that is a unique class that stores a File */
        class FileJButton extends JButton {
            private File file;

            public FileJButton(File file) {
                super(file.getName());
                this.file = file;
                this.setPreferredSize(new Dimension(0, 50));
                this.setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
            }

            public FileJButton(File file, String name) {
                super(name);
                this.file = file;
                this.setPreferredSize(new Dimension(0, 50));
                this.setMaximumSize(new Dimension(Integer.MAX_VALUE, 50));
            }

            public File file() {
                return file;
            }
        }
    }

    /** Enum that encodes the state of the menu */
    public enum SheetMenuState {
        NULL,
        HOME,
        MEASURE,
        CUT_SELECT,
        GCODE_SELECT,
        GCODE_SELECT_PART,
        EMIT_SELECT,
        ADD_ITEM,
        ADD_HOLE,
        ADD_CUT;
    }

    /**
     * @see SheetHandlerJButton
     */
    class SheetHandlerJButtonCut extends SheetHandlerJButton<Cut> {
        public SheetHandlerJButtonCut(String text, Cut genericThing) {
            super(text, genericThing);
        }
    }

    /**
     * @see SheetHandlerJButton
     */
    class SheetHandlerJButtonPart extends SheetHandlerJButton<Part> {
        public SheetHandlerJButtonPart(String text, Part genericThing) {
            super(text, genericThing);
        }
    }

    /**
     * @see SheetHandlerJCheckBox
     */
    class SheetHandlerJCheckBoxNGCDoc extends SheetHandlerJCheckBox<NGCDocument> {
        private Part part;

        public SheetHandlerJCheckBoxNGCDoc(String text, NGCDocument doc, Part part) {
            super(text, doc);
            this.part = part;
        }

        public Part getPart() {
            return part;
        }
    }

    /** New Popup Dialog for Tool Ordering */
    private static class ToolOrderDialog extends JDialog {
        private final DefaultListModel<Integer> listModel;
        private final JList<Integer> list;
        private List<Integer> result = null;

        public ToolOrderDialog(java.awt.Frame owner, List<Integer> tools) {
            super(owner, "Verify Tool Order", true); // Modal
            setLayout(new java.awt.BorderLayout());

            JLabel help = new JLabel("  Drag items to reorder:");
            help.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
            add(help, java.awt.BorderLayout.NORTH);

            listModel = new DefaultListModel<>();
            for (Integer t : tools)
                listModel.addElement(t);

            list = new JList<>(listModel);
            list.setDragEnabled(true);
            list.setDropMode(DropMode.INSERT);
            list.setTransferHandler(new ListTransferHandler());
            list.setBorder(BorderFactory.createEmptyBorder(5, 5, 5, 5));

            add(new JScrollPane(list), java.awt.BorderLayout.CENTER);

            JPanel buttons = new JPanel();
            JButton ok = new JButton("Confirm Emit");
            JButton cancel = new JButton("Cancel");

            ok.addActionListener(
                    e -> {
                        result = new ArrayList<>();
                        for (int i = 0; i < listModel.size(); i++)
                            result.add(listModel.get(i));
                        dispose();
                    });

            cancel.addActionListener(e -> dispose());

            buttons.add(cancel);
            buttons.add(ok);
            add(buttons, java.awt.BorderLayout.SOUTH);

            setSize(300, 400);
            setLocationRelativeTo(owner);
        }

        public List<Integer> getResult() {
            return result;
        }

        // Internal Transfer Handler for Drag-and-Drop
        private class ListTransferHandler extends TransferHandler {
            @Override
            public int getSourceActions(JComponent c) {
                return TransferHandler.MOVE;
            }

            @Override
            protected Transferable createTransferable(JComponent c) {
                return new StringSelection(String.valueOf(list.getSelectedIndex()));
            }

            @Override
            public boolean canImport(TransferSupport support) {
                return support.isDataFlavorSupported(DataFlavor.stringFlavor);
            }

            @Override
            public boolean importData(TransferSupport support) {
                try {
                    String data = (String) support.getTransferable().getTransferData(DataFlavor.stringFlavor);
                    int fromIndex = Integer.parseInt(data);
                    JList.DropLocation dl = (JList.DropLocation) support.getDropLocation();
                    int toIndex = dl.getIndex();

                    if (fromIndex < 0
                            || fromIndex >= listModel.getSize()
                            || toIndex < 0
                            || toIndex > listModel.getSize())
                        return false;

                    Integer val = listModel.get(fromIndex);
                    listModel.remove(fromIndex);
                    if (fromIndex < toIndex)
                        toIndex--;
                    listModel.add(toIndex, val);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        }
    }
}