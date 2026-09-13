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

public class Screen extends JPanel
		implements MouseWheelListener,
		MouseInputListener,
		ActionListener,
		ListSelectionListener,
		ItemListener {
	public static Screen screen;
	public static final boolean DebugMode = Boolean.parseBoolean(Settings.settings.get("DebugMode"));
	private JList<File> sheetList;
	private JScrollPane sheetScroll;
	private DefaultListModel<File> sheetFileList;
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
		state = State.SHEET_SELECT;

		sheetFileList = new DefaultListModel<>();
		sheetsParent = new File(Settings.settings.get("SheetParentFolder"));
		for (int i = 0; i < sheetsParent.listFiles().length; i++) {
			sheetFileList.addElement(
					new File(sheetsParent.listFiles()[i].getAbsolutePath()) {
						@Override
						public String toString() {
							return getName();
						}
					});
		}

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
		sheetScroll.setBounds(100, 100, 225, 600);
		add(sheetScroll);
		sheetList.addListSelectionListener(this);

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
		try {
			BufferedImage img = ImageIO.read(new File(Settings.settings.get("SettingsIconImage")));
			BufferedImage img2 = ImageIO.read(new File(Settings.settings.get("SettingsIconImage2")));
			toSettings.setIcon(new ImageIcon(img2));
			toSettings.setRolloverIcon(new ImageIcon(img));
			toSettings.setPressedIcon(new ImageIcon(img));
			toSettings.setBackground(new Color(33, 30, 31));
			toSettings.setBorderPainted(false);
		} catch (IOException e) {
			toSettings.setText("Settings");
			toSettings.setBounds(1200 - 200, 0, 200, 50);
		}

		returnToHomeMenu = new ReturnToHomeJButton("Return to Home");
		returnToHomeMenu.addActionListener(this);

		returnOnce = new ReturnOnceJButton("Return");
		returnOnce.addActionListener(this);

		itemSelectMenu = new ItemSelectMenu();
		add(itemSelectMenu);
		itemSelectMenu.setVisible(false);
		itemSelectMenu.setBounds(editMenu.getBounds());
		menuPanels.add(itemSelectMenu);

		try {
			for (File file : new File("Display").listFiles()) {
				if (file.getName().substring(file.getName().lastIndexOf('.') + 1).equals("jav")) {
					imgs.add(ImageIO.read(file));
				}
			}
		} catch (IOException | NullPointerException e) {
			System.err.println("Logo not Found");
		}

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

	@Override
	public Dimension getPreferredSize() {
		return new Dimension(1200, 800);
	}

	@Override
	public void paintComponent(Graphics g) {
		super.paintComponent(g);
		g.setColor(new Color(33, 30, 31));
		g.fillRect(0, 0, getWidth(), getHeight());
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
