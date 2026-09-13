package Parser.GCode;

import SheetHandler.Part;
import java.awt.geom.Point2D;
import java.util.HashMap;

public interface GenericGCodeParser extends GenericParser {
    public void addGCodeAttributes(HashMap<String, Double> attributes, NGCDocument doc);

    public String getGCodeHeader(NGCDocument doc);

    public String getGCodeBody(NGCDocument doc);

    public String getGCodeFooter(NGCDocument doc);

    public String removeGCodeSpecialness(String gCode);

    public default String gCodeTransformClean(Part part) {
        return gCodeTransformClean(part, null);
    }

    public default String gCodeTransformClean(Part part, int toolNum) {
        return gCodeTransformClean(part, toolNum, null);
    }

    public String gCodeTransformClean(Part part, Point2D origin);

    public String gCodeTransformClean(Part part, int toolNum, Point2D origin);

    public String getToolCode(int toolNum);
}
