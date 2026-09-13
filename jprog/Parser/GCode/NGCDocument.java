package Parser.GCode;

import Display.Screen;
import java.awt.geom.Point2D;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;

public class NGCDocument {
    private File gcodeFile;
    private Point3D currentPoint;
    private int SpindleSpeed;
    private double implicitGCodeHolder;
    private boolean isRelativeArc = true;
    private boolean isRelative = false;
    private int currentAxisPlane = 0;
    private double lastI = 0;
    private double lastJ = 0;
    private HashMap<String, Double> previousAttributes = new HashMap<>();
    private boolean machineCoordinates = false;
    private StringBuilder gCodeStringBuilder;
    private boolean inchesMode = true;
    private NgcStrain ngcStrain;
    private HashMap<Integer, ToolInfo> toolLibrary = new HashMap<>();
    private LinkedHashMap<Integer, ArrayList<RelativePath2D>> toolLayers = new LinkedHashMap<>();
    private LinkedHashMap<Integer, StringBuilder> toolScripts = new LinkedHashMap<>();
    private int currentToolNumber = 0;
    // 0=Off, 1=Left (G41), 2=Right (G42)
    private int currentCutterCompMode = 0;

    public NGCDocument() {
        this(null, null);
    }

    public int getCurrentAxisPlane() {
        if (currentAxisPlane < 17 || currentAxisPlane > 19) {
            throw new IllegalGCodeError(
                    "Axis Plane "
                            + currentAxisPlane
                            + " is not supported or needs to be called before an arc");
        }
        return currentAxisPlane;
    }

    public void setCurrentAxisPlane(int GCode) {
        if (GCode < 17 || GCode > 19) {
            throw new IllegalGCodeError(
                    "Axis Plane " + GCode + " is not supported or needs to be called before an arc");
        }
        currentAxisPlane = GCode;
    }

    public void setCurrentPoint(Point3D point) {
        currentPoint = point;
    }

    public Point3D getCurrentPointr() {
        return currentPoint;
    }

    public void setGCodeHolder(double GCode) {
        implicitGCodeHolder = GCode;
    }

    public double getGCodeHolder() {
        return implicitGCodeHolder;
    }

    public boolean contains(Point2D point) {
        for (ArrayList<RelativePath2D> layer : toolLayers.values()) {
            for (RelativePath2D path : layer) {
                if (path.contains(point)) {
                    return true;
                }
            }
        }
        return false;
    }

    public void setIsRelative(boolean isRelative) {
        this.isRelative = isRelative;
    }

    public boolean getRelativity() {
        return isRelative;
    }

    public void setIsRelativeArc(boolean isRelativeArc) {
        this.isRelativeArc = isRelativeArc;
    }

    public boolean getRelativityArc() {
        return isRelativeArc;
    }

    public NGCDocument(File file, NgcStrain ngcStrain) {
        this.gcodeFile = file;
        gCodeStringBuilder = new StringBuilder();
        this.ngcStrain = ngcStrain;
        changeTool(0);
        toolScripts.put(0, new StringBuilder()); // Bucket for header/setup
    }

    public ArrayList<RelativePath2D> getRelativePath2Ds() {
        ArrayList<RelativePath2D> allPaths = new ArrayList<>();
        HashMap<Integer, ArrayList<RelativePath2D>> layers = getToolpathLayers();
        for (ArrayList<RelativePath2D> layer : layers.values()) {
            allPaths.addAll(layer);
        }
        return allPaths;
    }

    public HashMap<Integer, ArrayList<RelativePath2D>> getToolpathLayers() {
        HashMap<Integer, ArrayList<RelativePath2D>> output = new HashMap<>();

        for (Integer toolNum : toolLayers.keySet()) {
            ArrayList<RelativePath2D> layerPaths = toolLayers.get(toolNum);
            // Get the specific radius for this tool (default 0.0)
            double thisToolRadius = toolLibrary.getOrDefault(toolNum, new ToolInfo()).toolRadius();

            ArrayList<RelativePath2D> offsetPaths = new ArrayList<>();
            for (RelativePath2D path : layerPaths) {
                // Calculate the offset path based on THIS tool's radius
                offsetPaths.add(path.getOffsetInstance2(thisToolRadius));
            }
            output.put(toolNum, offsetPaths);
        }
        return output;
    }

    private ArrayList<RelativePath2D> getOffsetGeometryAll() {
        ArrayList<RelativePath2D> output = new ArrayList<>();

        for (Integer toolNum : toolLayers.keySet()) {
            ArrayList<RelativePath2D> layerPaths = toolLayers.get(toolNum);

            // Find the offset for THIS specific tool (default to 0.0 if missing)
            double thisToolRadius = toolLibrary.getOrDefault(toolNum, new ToolInfo()).toolRadius();

            // Calculate offset for every path in this layer
            for (RelativePath2D path : layerPaths) {
                // Apply the specific radius for this tool
                output.add(path.getOffsetInstance2(thisToolRadius));
            }
        }
        return output;
    }

    protected RelativePath2D getCurrentPath2D() {
        ArrayList<RelativePath2D> currentGeometry = toolLayers.get(currentToolNumber);
        return currentGeometry.get(currentGeometry.size() - 1);
    }

    protected void newPath2D() {
        RelativePath2D newPath = new RelativePath2D();
        if (currentCutterCompMode == 1)
            newPath.offsetLeft();
        else if (currentCutterCompMode == 2)
            newPath.offsetRight();

        toolLayers.get(currentToolNumber).add(newPath);
    }

    public void setGcodeFile(File file) {
        this.gcodeFile = file;
    }

    public File getGcodeFile() {
        return gcodeFile;
    }

    public void setSpindleSpeed(int SpindleSpeed) {
        this.SpindleSpeed = SpindleSpeed;
    }

    public int getSpindleSpeed() {
        return SpindleSpeed;
    }

    public void setLastArcCenter(double i, double j) {
        lastI = i;
        lastJ = j;
    }

    public double lastI() {
        return lastI;
    }

    public double lastJ() {
        return lastJ;
    }

    public void addGCodeAttributes(HashMap<String, Double> attributes) {
        ngcStrain.gCodeParser.addGCodeAttributes(attributes, this);
    }

    public void setUsingMachineCoordinates(boolean b) {
        machineCoordinates = b;
    }

    public boolean usingMachineCoordinates() {
        return machineCoordinates;
    }

    public void addToString(String lineToAdd) {
        gCodeStringBuilder.append("\n" + lineToAdd);

        toolScripts.putIfAbsent(currentToolNumber, new StringBuilder());
        toolScripts.get(currentToolNumber).append("\n" + lineToAdd);
    }

    public String getGCodeForTool(int toolNumber) {
        return toolScripts.getOrDefault(toolNumber, new StringBuilder()).toString();
    }

    public String getGCodeString() {
        return gCodeStringBuilder.toString();
    }

    public NgcStrain getNgcStrain() {
        return ngcStrain;
    }

    public HashMap<String, Double> getPreviousAttributes() {
        return previousAttributes;
    }

    public boolean isInchesMode() {
        return inchesMode;
    }

    protected void setInchesMode(boolean newMode) {
        inchesMode = newMode;
    }

    protected void setPreviousAttributes(HashMap<String, Double> newAttributes) {
        previousAttributes = newAttributes;
    }

    public String getGCodeHeader() {
        return ngcStrain.gCodeParser.getGCodeHeader(this);
    }

    public String getGCodeBody() {
        return ngcStrain.gCodeParser.getGCodeBody(this);
    }

    public String getGCodeFooter() {
        return ngcStrain.gCodeParser.getGCodeFooter(this);
    }

    public void defineTool(int toolNumber, double diameter) {
        toolLibrary.put(toolNumber, new ToolInfo(diameter / 2.0)); // Store radius
    }

    public void changeTool(int toolNumber) {
        if (toolScripts.containsKey(currentToolNumber)) {
            String rawBody = toolScripts.get(currentToolNumber).toString();
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("G53[^\\n]*Z").matcher(rawBody);

            int i = -1;
            while (m.find())
                i = m.start(); // Loop finds the LAST matching index

            toolScripts.put(
                    currentToolNumber,
                    new StringBuilder(rawBody.substring(0, i == -1 ? rawBody.length() : i)));
        }
        this.currentToolNumber = toolNumber;

        // Create layer if it doesn't exist
        if (!toolLayers.containsKey(toolNumber)) {
            ArrayList<RelativePath2D> newLayer = new ArrayList<>();
            newLayer.add(new RelativePath2D());
            toolLayers.put(toolNumber, newLayer);
        }

        // Reset comp mode on tool change for safety
        setCutterCompMode(0);
    }

    public void setCutterCompMode(int mode) {
        this.currentCutterCompMode = mode;
        // Apply immediately to current path
        if (mode == 1)
            getCurrentPath2D().offsetLeft();
        else if (mode == 2)
            getCurrentPath2D().offsetRight();
    }

    public void setToolOffset(ToolInfo num) {
        // Save this offset for the CURRENT tool
        toolLibrary.put(currentToolNumber, num);
        if (Screen.DebugMode)
            System.out.println("Updated T" + currentToolNumber + " offset to: " + num);
    }

    public ToolInfo getToolOffset(int num) {
        return toolLibrary.getOrDefault(num, new ToolInfo());
    }

    public HashMap<Integer, ToolInfo> getToolTable() {
        return toolLibrary;
    }
}
