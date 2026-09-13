def calc(a):
     a -= 1
     a /= 2
     a = 0.07875 - a
     a *= 2
     return a

while True:
	print(calc(float(input("Side Size(~1\" side): "))))